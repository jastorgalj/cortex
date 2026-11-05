# Proposal — el borrado avanza la revisión y conserva la autoría del contenido

## Why

Tres defectos en el borrado lógico, encontrados revisando el código y confirmados ejecutándolo contra la
base local:

1. **La revisión final ocupa el número que la próxima actualización necesita.** `softDeleteNote`
   inserta la revisión con `rev = notes.rev` sin avanzar la nota (`src/db/notes.ts:376` y `:386`), y el
   PK de `note_revisions` es `(note_id, rev)`. Reproducido: nota en rev 2 → borrar → limpiar
   `deleted_at` (recuperar) → `updateNote` falla con
   `Unique constraint failed on the fields: (note_id, rev)`. El propio spec dice que una nota borrada
   por error SHALL poder recuperarse: hoy la recuperación deja la nota inmutable.
2. **El historial atribuye el contenido a quien borró.** La revisión final guarda el cuerpo vigente con
   `author` = autor del borrado (`src/db/notes.ts:380`). Reproducido: nota escrita por `ana` (rev 1) y
   actualizada por `beto` (rev 2), borrada por `caro` → el historial muestra `1:ana` y `2:caro`: la
   autoría del contenido vigente desaparece, y el nombre de quien borró queda indistinguible de un
   autor que editó.
3. **La validación de `author`/`reason` vive solo en la tool.** `createNote` y `updateNote` validan en
   la capa de datos (`src/db/notes.ts:248`), `softDeleteNote` no; el chequeo está en
   `src/tools/mcp-server.ts:306-335`. Cualquier otro llamador (importación, script, una futura ruta
   REST de escritura) puede borrar con `author` vacío.

Ninguno de los tres se ve desde el uso normal: aparecen al recuperar una nota, al auditar quién cambió
qué, y al agregar un segundo punto de escritura.

## What Changes

- `softDeleteNote` valida `author` y `reason` no vacíos y rechaza con `ValidationError` nombrando el
  campo, igual que el resto de las operaciones.
- La revisión final del borrado conserva el `author` del contenido vigente; el nombre de quien borró
  pasa al `reason`, con el motivo recibido.
- El borrado avanza `notes.rev` en uno, de modo que el número ocupado por la revisión final no es el que
  la siguiente actualización de esa nota necesita.
- Los tests de borrado se actualizan a la nueva semántica y se agregan los dos casos que faltaban:
  revisión avanzada, y recuperación seguida de actualización sin colisión.

## Capabilities

### New Capabilities

Ninguna. Los tres cambios son correcciones de comportamiento ya especificado en `notas`.

### Modified Capabilities

- `notas`: el requirement «El borrado deja una revisión final en el historial» cambia en dos cosas
  observables —la revisión final conserva la autoría del contenido y registra aparte quién borró, y la
  nota borrada avanza de revisión—. El requirement «El borrado por tool exige autoría y motivo» no
  cambia: la validación en la capa de datos es una decisión de diseño (ver `design.md`), no un
  requirement nuevo.

## Impact

- Código: `src/db/notes.ts` (borrado y validación), `src/tools/mcp-server.ts` (solo si el mensaje de
  error se duplica), `test/delete.test.ts` y `test/notes.test.ts`.
- Esquema: **sin migración**. Se usan columnas y tablas existentes.
- Contrato de las tools: `cortex_delete` no cambia de firma; cambia lo que devuelve `cortex_history`
  para las notas borradas.
- Consumidores: el importador y la vista web leen `note_revisions`; ambos toleran la nueva forma (el
  `reason` de la revisión final ahora incluye el nombre de quien borró).

## Fuera de alcance

- **`base_rev` en `cortex_delete`.** Hoy el borrado es «último gana»: un agente puede borrar una nota que
  otro actualizó en el medio sin enterarse. Se deja fuera porque suma fricción a una operación rara y
  ninguna card lo pide; queda como candidato a change propio.
- **Restaurar una nota desde las tools.** El borrado sigue siendo lógico pero no hay operación de
  recuperación; este change solo garantiza que la recuperación no quede bloqueada cuando exista.
- **Validar `author` contra una lista de autores conocidos.** Sigue siendo declarativo, como el resto del
  modelo.
