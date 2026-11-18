# Tasks — respuestas MCP acotadas (GitHub #17)

> Entorno: worktree `/home/jam/develop/varios/cortex/.worktrees/issue-17-paginacion`, rama
> `feat/issue-17-paginacion`. Postgres local de docker-compose (`127.0.0.1:5433`, DB `cortex_test` que
> crea y migra `test/preload.ts`). Baseline medida antes de tocar código sobre `origin/main`
> (`2783e8c`): **276 pass / 3 fail** (los 3 fallos son de `health`/`shutdown`, preexistentes en esa
> rama; ver verificación final). Typecheck: `bun run typecheck`. No hay migración: el cambio no toca
> `prisma/`.

## 1. Capa de datos

- [x] 1.1 `src/db/notes.ts:535` — extraer `buildListWhere(prisma, filter)` y hacer que
  `listNotes` (`:566`) lo use; el filtro por tags se mueve de memoria a SQL (`array_contains`,
  misma semántica AND).
- [x] 1.2 `src/db/notes.ts:581` — `listNotesPage(prisma, filter, limit, offset)` con `count` +
  `findMany({ take, skip })`, devolviendo `{ total, items, next_offset }`; constantes
  `LIST_PAGE_DEFAULT = 50` / `LIST_PAGE_MAX = 200` (`:136`).
- [x] 1.3 `src/db/notes.ts:682` — `getNoteHistory(prisma, noteId, { rev, include_body, limit })`
  que devuelve `{ total, items }`; sin `limit` mantiene el historial completo en orden ascendente,
  con `limit` recorta a las revisiones más recientes.
- [x] 1.4 `src/db/constants.ts:27` — `headlineSnippet(query)` y `cleanSnippet(text)`.
- [x] 1.5 `src/db/notes.ts:717` y `src/db/search.ts:115` — la rama léxica usa `ts_headline`;
  `rrfFusion` conserva el snippet de la rama léxica y los resultados solo semánticos usan el inicio
  del cuerpo.

## 2. Tools MCP

- [x] 2.1 `src/tools/mcp-server.ts:358` — `cortex_list` declara `limit`/`offset` y responde
  `{ total, items, next_offset }` sin `body_md`.
- [x] 2.2 `src/tools/mcp-server.ts:445` — `cortex_history` declara `rev`, `include_body` y `limit`;
  por defecto solo metadatos, `rev` trae el cuerpo de esa revisión.
- [x] 2.3 `JSON.stringify` compacto en todas las respuestas (`withWarnings` en `:70` y las cinco
  tools restantes).

## 3. Documentación

- [x] 3.1 `README.md` — la tabla de tools dice que `cortex_list` pagina y que `cortex_history`
  devuelve metadatos por defecto.
- [x] 3.2 Deltas de spec en `openspec/changes/2026-11-18-respuestas-acotadas/specs/`.

## 4. Verificación

- [x] 4.1 `bun run typecheck` — sin errores.
- [x] 4.2 `bun run test` — 280 pass / 3 fail; los 3 fallos (`GET /health — BD caída` x2 y
  `createShutdown`) son los mismos que fallan en `origin/main` sin este cambio.
- [x] 4.3 Tests nuevos: paginación con `limit`/`offset` y `next_offset` (`test/mcp.test.ts`),
  historial sin cuerpos + `rev` + `limit` (`test/mcp.test.ts`), respuestas sin indentación
  (`test/mcp.test.ts`) y snippet con el término después de los 200 primeros caracteres
  (`test/search.test.ts`).
- [ ] 4.4 Validar con `openspec validate 2026-11-18-respuestas-acotadas` y mergear el PR (lo hace Juan).
