# Design — borrado: revisión avanzada y autoría del contenido

## Decisión 1 — El borrado avanza `notes.rev` en uno

**Qué:** el `UPDATE` del borrado pasa de `{ deleted_at }` a `{ deleted_at, rev: { increment: 1 } }`,
dentro de la misma transacción que ya toma `SELECT … FOR UPDATE`.

**Por qué:** `note_revisions` tiene PK `(note_id, rev)` y `updateNote` inserta su revisión en
`current.rev` antes de incrementar. La revisión del borrado usa exactamente ese número, así que el
siguiente `cortex_update` —después de recuperar la nota— choca con el PK. Reproducido antes del cambio:

```
revs antes: [ "1:ana:-", "2:caro:ya no aplica" ]
update tras restaurar FALLA: Unique constraint failed on the fields: (`note_id`,`rev`)
```

**Alternativa descartada:** insertar la revisión del borrado en `rev + 1` y dejar `notes.rev` quieto.
Deja el dato igual de inconsistente (`notes.rev` deja de ser «la última revisión del historial») y
mueve el problema al siguiente lector en vez de resolverlo.

**Alternativa descartada:** un `rev` propio para eventos que no son contenido (p. ej. `rev = 0` o
`reason` con prefijo). Rompe el escenario de numeración correlativa 1, 2, 3 del spec y obliga a
distinguir dos tipos de fila en `cortex_history`, que es la superficie que el usuario lee.

## Decisión 2 — La revisión final conserva el autor del contenido; quien borra va al `reason`

**Qué:** `author: note.author` (el autor de la versión vigente) y
`reason: '<motivo recibido> (borrada por <author del borrado>)'`.

**Por qué:** hoy el historial dice que el contenido lo escribió quien borró. Con dos autores en juego
—el que escribió y el que borra— el único campo de texto libre que ya existe es `reason`; usarlo evita
una migración en dos bases (local y Neon).

**Alternativa descartada:** columnas `deleted_by` y `delete_reason` en `notes`. Es lo semánticamente
correcto, pero cuesta una migración y contradice la decisión ya tomada en
`changes/archive/2026-11-04-cortex-renombre-y-borrado/design.md` («Reutilizar `note_revisions` evita una
migración … para un dato que ya tiene casa»). Si alguna vez se necesita consultar «quién borró» de
forma estructurada, esa migración es el camino y este `reason` deja el dato disponible para
backfillearla.

**Consecuencia aceptada:** `reason` deja de ser texto libre puro en la revisión final. El formato es
`<motivo> (borrada por <autor>)` y el test lo verifica por contenido, no por igualdad exacta, para que
un cambio de redacción no rompa la suite.

## Decisión 3 — La validación de `author`/`reason` se mueve a `softDeleteNote`

**Qué:** la capa de datos rechaza con `ValidationError(campo)`; el tool conserva su chequeo y su
mensaje porque es el que el agente lee.

**Por qué:** `createNote` y `updateNote` ya validan ahí; el borrado era la única operación que dependía
del llamador. El servidor declara un solo punto de escritura (`/mcp`), pero el importador y los scripts
llaman a la capa de datos directamente, así que el invariante tiene que vivir en la capa de datos.

**Alternativa descartada:** un helper común de validación para las tres operaciones. Es un refactor que
este change no necesita (KISS) y que tocaría los mensajes que los tests de `create`/`update` ya fijan.

## Non-Goals

- `base_rev` en el borrado (último-gana declarado en el proposal).
- Restaurar una nota desde las tools: el change deja el PK libre, no implementa la operación.
- Cambiar el formato de `cortex_history`: los DTO siguen igual (`rev`, `author`, `reason`, cuerpo).

## Riesgo y mitigación

- **Riesgo:** un consumidor que hoy muestre `reason` como texto corto verá la coletilla
  «(borrada por …)». **Mitigación:** la vista web muestra `reason` como texto libre y el test cubre el
  contenido; el cambio es aditivo.
- **Riesgo:** tests existentes que asertan `author` = quien borra. **Mitigación:** se actualizan en el
  mismo change (`test/delete.test.ts`), porque el comportamiento que probaban es el defecto.
