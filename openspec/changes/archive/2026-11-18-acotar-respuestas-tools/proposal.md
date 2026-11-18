## Why

Los resultados de las tools van enteros al contexto del agente y crecen con el corpus (GitHub #17). Medido sobre un corpus de 79 notas con la forma del real (cuerpo p50 1.868, p90 8.641, máx 30.436 caracteres; 17 notas con más de una revisión):

- `cortex_list` sin argumentos devuelve las 79 notas en 33.916 caracteres (≈ 8.500 tokens); el servidor real (79 notas) da 35.720. Sin tope ni paginación, a 800 notas serían ≈ 340.000 caracteres.
- `cortex_history` devuelve cada revisión con su `body_md` completo: 8.185 caracteres para una nota con 2 revisiones y 104.754 para una de 30 mil caracteres con 4 (`src/db/notes.ts:571-590`, `src/tools/mcp-server.ts:335-336`).
- Las respuestas se serializan con `JSON.stringify(x, null, 2)` en 8 sitios (`src/tools/mcp-server.ts:64, 88, 158-168, 174, 257, 312, 336, 390-394`); la indentación suma 23 % de caracteres (list: 33.916 → 26.112 sin ella).
- El snippet de `cortex_search` son los primeros 200 caracteres del cuerpo (`src/db/search.ts:26-28`, `:142`): una palabra que aparece después del carácter 200 no se ve en el resultado aunque sea la que hizo coincidir la nota.

## What Changes

- `cortex_list`: parámetros `limit` (1–200, defecto 50) y `offset` (≥ 0, defecto 0); responde `{ total, items, next_offset }`. **Cambia la forma de la respuesta** (hoy es un arreglo).
- `cortex_history`: por defecto solo metadatos (sin `body_md`) y las 10 revisiones más recientes; `include_body: true` trae los cuerpos; `rev: N` trae el cuerpo de esa revisión. Responde `{ total, items }`. **Cambia la forma de la respuesta** (hoy es un arreglo con cuerpos).
- Todas las respuestas JSON de las siete tools salen compactas (sin indentación).
- `cortex_search`: el snippet de los resultados léxicos es el fragmento donde coincide el término (`ts_headline`), no el inicio del cuerpo.
- Tope duro de 20.000 caracteres en `cortex_list` y `cortex_history`: se quitan ítems enteros y la respuesta lleva `truncated: true`.
- El filtro `tags` de `cortex_list` pasa de memoria a SQL para que `total` y las páginas sean correctos.

## Fuera de alcance

- Vista web `GET /` (`src/index.ts:97-101`): sigue llamando `listNotes(prisma)` sin límite. La consume una persona, no el contexto de un agente; paginarla es otra decisión de producto.
- `cortex_read`, `cortex_write`, `cortex_update` y `cortex_delete`: solo ganan JSON compacto. `cortex_read` devuelve la nota completa por diseño y no se topa. Que `cortex_write` y `cortex_update` devuelvan de vuelta el `body_md` que el agente acaba de enviar (`src/tools/mcp-server.ts:174, 257`) es un costo real del mismo tipo; queda para otro issue porque cambia el contrato de esas tools.
- `issue` y `force_reason` en el historial: la tabla `note_revisions` no tiene esas columnas (`prisma/schema.prisma`, modelo `NoteRevision`); agregarlas exige una migración y no se pidió.
- Paginación por cursor opaco y paginación de `cortex_search` (ya acotada: `limit` 1–50).
- Imagen GHCR, release y bump de versión.

## Impact

- Archivos nuevos: `src/tools/respuesta.ts` (serialización compacta y tope), `test/paginacion.test.ts`.
- Archivos editados: `src/tools/mcp-server.ts` (handlers de `cortex_list`, `cortex_history`, `cortex_search` y las 8 serializaciones), `src/db/notes.ts` (`listNotesPage`, `getNoteHistoryPage`; `listNotes` y `getNoteHistory` conservan su firma), `src/db/search.ts`, `test/mcp.test.ts`, `test/delete.test.ts`, `README.md`, `skills/cortex-mcp/SKILL.md`.
- Spec: capabilities `notas` (2 MODIFIED, 4 ADDED), `busqueda` (1 MODIFIED, 6 ADDED) y `servidor-mcp` (5 ADDED). Sin migraciones ni cambios de esquema.
- Contrato: dos tools cambian la forma de su respuesta; los consumidores son agentes que leen el texto, y en el repo solo los tests lo parsean (`grep` en `src/`, `scripts/` y `skills/`).
