# Tasks — borrado: revisión avanzada y autoría del contenido

## 1. Capa de datos (`src/db/notes.ts`)

- [x] 1.1 En `softDeleteNote`, rechazar `author` y `reason` vacíos o en blanco con
  `ValidationError` nombrando el campo (`'author'` / `'reason'`), antes de abrir la transacción, igual
  que hace `updateNote` con `author`. Mensaje en castellano, con el campo en el constructor.
  — Verificado por «softDeleteNote — validación en la capa de datos (sin la tool)» en
  `test/delete.test.ts`, que prueba `''` y `'   '` en ambos campos y aserta `err.field`.
- [x] 1.2 La revisión final del borrado guarda `author: note.author` (autor del contenido vigente) y
  `reason: \`${reason} (borrada por ${author})\`` — donde el primer `reason` es el recibido y el segundo
  `author` es quien borra.
  — Verificado por el test de historial: `lastRev.author === 'editor-dos'` (autor del contenido) y
  `reason` contiene el motivo y «maria» (quien borró).
- [x] 1.3 El `UPDATE` del borrado avanza la revisión: `{ deleted_at, rev: { increment: 1 } }`, en la
  misma transacción y después del `SELECT … FOR UPDATE` que ya existe.
  — Verificado por «borrar una nota en rev 3 → readNote is_deleted con rev 4» en `test/notes.test.ts`.
- [x] 1.4 El tipo de retorno de `softDeleteNote` incluye la `rev` resultante
  (`{ id, deleted_at, rev }`), leída del registro actualizado — no calculada a mano.
  — El retorno toma `rev: updated.rev` del registro que devuelve `tx.note.update`; el test compara
  contra el valor devuelto por la propia llamada y por `readNote`, no contra una constante calculada.

## 2. Tool MCP (`src/tools/mcp-server.ts`)

- [x] 2.1 `cortex_delete` no cambia de firma. Confirmar que su validación sigue respondiendo el mensaje
  que nombra el parámetro (los tests de `test/delete.test.ts` lo cubren) y que no duplica el formato del
  `reason`: si necesita mostrarlo, que use el que devuelve la capa de datos.
  — Firma intacta; los 2 tests de «validación de parámetros» siguen en verde y el `reason` que se
  devuelve es el de la capa de datos, sin reformateo en la tool.
- [x] 2.2 La respuesta de `cortex_delete` incluye la `rev` nueva, para que el agente sepa en qué
  revisión quedó la nota borrada.
  — Verificado por `expect(deleteData.rev).toBe(4)` en el test de historial.

## 3. Tests (`test/delete.test.ts`, `test/notes.test.ts`)

- [x] 3.1 Actualizar el test «nota con 2 revisiones → history tiene 3 revs…»: la última revisión tiene
  `author` = autor del contenido vigente y un `reason` que contiene el motivo y el nombre de quien
  borró (aserto por contenido, no por igualdad exacta).
  — Aserta `lastRev.author === 'editor-dos'` y `reason` contiene «duplicada de otra nota» y «maria».
- [x] 3.2 Test nuevo: borrar una nota en rev 3 → `readNote` responde `is_deleted: true` con `rev: 4`, y
  ninguna revisión del historial usa el número 4.
  — «borrar una nota en rev 3 → readNote is_deleted con rev 4 y ninguna revisión usa el 4»
  (`test/notes.test.ts`): `history.map(h => h.rev)` es `[1,2,3]`.
- [x] 3.3 Test nuevo (regresión del defecto encontrado): nota con una actualización → borrar →
  `UPDATE notes SET deleted_at = NULL` → `updateNote` con `base_rev` de la revisión vigente **funciona**
  y deja la revisión siguiente. Hoy falla con `Unique constraint failed on the fields: (note_id,rev)`.
  — «regresión: borrar, recuperar y actualizar no colisiona con el PK (note_id, rev)»: `updated.rev === 4`
  e historial `[1,2,3]`. Con el `increment` revertido el test se pone rojo (ver 3.5).
- [x] 3.4 Test nuevo: `softDeleteNote` llamada **directo** (sin la tool) con `author` o `reason` vacíos
  lanza `ValidationError` y la nota sigue visible en `cortex_list`.
  — El mismo test de 1.1: además aserta que el id sigue en `cortex_list` y que `cortex_history` está vacío.
- [x] 3.5 Prueba de que los tests nuevos pueden fallar: revertir cada fix a mano (volver
  `author: author`, quitar el `increment`, quitar la validación), confirmar el rojo del test
  correspondiente, restaurar el fix. Dejar en el handoff qué se rompió y qué test se puso rojo.
  — Ejecutado en la card de cierre, con backup y `sha256sum -c` confirmando restauración byte a byte.
  1) `author: note.author` → `author` **y** sin las validaciones: `test/delete.test.ts` 5 pass / 2 fail
  («la última conserva el autor del contenido» y «validación en la capa de datos»).
  2) sin `rev: { increment: 1 }`: `test/notes.test.ts` 15 pass / 2 fail (rev 4 y regresión del PK).
  3) sin `rev` en la respuesta de la tool: `test/delete.test.ts` 6 pass / 1 fail (el aserto `rev === 4`).
- [x] 3.6 Ajustar `test/notes.test.ts` si algún caso del flujo de borrado asume la semántica vieja.
  — No hubo que ajustar ninguno: el `describe('softDelete')` previo pasa sin cambios con la nueva
  semántica; el archivo solo suma el `describe` nuevo.

## 4. Verificación de cierre

- [x] 4.1 `export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck` sin errores.
  — `bunx tsc --noEmit`, exit 0, sin salida.
- [x] 4.2 `bun test` completo en verde (suite actual: 63 tests; debe subir con los 3 nuevos). Los tests
  usan la base local `cortex_test` en `127.0.0.1:5433`, no el `.env`.
  — 66 pass / 0 fail / 203 `expect()` en 6 archivos, contra el contenedor `cortex-db-test`.
- [x] 4.3 `openspec validate notas-borrado-revision-sin-colision --strict` en verde.
  — `Change 'notas-borrado-revision-sin-colision' is valid` (con `--type change --strict`).

## Workflow follow-up

- Commit, push de la rama y PR a `main` los hizo la card de cierre (`t_7eccef66`); el repo solo tiene
  `main`, no hay `develop`. El PR no se mergea: lo decide el autor.
- Sin migración de esquema: no hay columnas ni índices nuevos. `prisma migrate deploy` no hizo falta.
- El change se archivó con `openspec archive` en la card de cierre, después de conciliar estas casillas.
