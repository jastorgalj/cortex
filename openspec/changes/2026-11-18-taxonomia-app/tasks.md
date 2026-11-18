# Tasks — taxonomía de `app`

> Entorno: worktree `<repo>/.worktrees/issue-12`, rama `feat/issue-12-taxonomia-app`, base `main`.
> Postgres del compose en `127.0.0.1:5433` (`docker compose up -d db`). Gates:
> `bun run typecheck` y `MODEL_CACHE_DIR=<modelo cacheado> bun run test`.

## 1. Vocabulario y normalización

- [x] 1.1 Crear `src/db/apps.ts` con `getAppConfig` (`CORTEX_APPS`, `CORTEX_APP_ALIASES`,
  `CORTEX_APP_MODE`), `canonicalApp`, `resolveApp` (alias + vocabulario, `warn`/`strict`) y
  `appFilterValues` (`general` incluido por defecto).
- [x] 1.2 `createNote` resuelve `app` antes de escribir y persiste el canónico; un rechazo sale como
  `ValidationError` con `field: "app"`.
- [x] 1.3 `updateNote` aplica el mismo camino cuando la corrección trae `app`, y devuelve `warnings`.
- [x] 1.4 `cortex_write` incluye `warnings` en la respuesta solo cuando existen.

## 2. `general` transversal en listado y búsqueda

- [x] 2.1 `ListFilter.include_general` (default `true`); `listNotes` filtra con `app IN (...)`.
- [x] 2.2 `SearchFilter.include_general`; `hybridSearch` filtra las dos ramas (léxica y semántica) con
  `app IN (...)` antes del `LIMIT`.
- [x] 2.3 `SearchResult` gana `app`, propagado por `rrfFusion`.
- [x] 2.4 `lexicalSearch` acepta `include_general` y filtra igual.

## 3. Descubrimiento

- [x] 3.1 `countNotesByApp` en `src/db/notes.ts` (`groupBy app`, solo no borradas).
- [x] 3.2 Tool `cortex_apps` con `{ apps, vocabulary }`.
- [x] 3.3 `GET /api/apps` con el mismo payload y `include_general` en `/api/search`.

## 4. Documentación y contrato

- [x] 4.1 Schema de `cortex_write`/`cortex_update` describe el vocabulario configurado
  (`APP_DESCRIPTION`), y `cortex_list`/`cortex_search` describen `include_general`.
- [x] 4.2 `.env.example` documenta las tres variables; `docker-compose.yml` las pasa al contenedor.
- [x] 4.3 `README.md` y `skills/cortex-mcp/SKILL.md` coherentes con `general` y `cortex_apps`.
- [x] 4.4 Specs: delta en `notas`, `busqueda` y `servidor-mcp` + actualización de los specs vigentes.

## 5. Tests

- [x] 5.1 `test/apps.test.ts`: `resolveApp` (sin vocabulario, alias, warn, strict, `general`),
  `appFilterValues`, `listNotes` con y sin `include_general`, `hybridSearch` en las dos ramas,
  `createNote` (alias, warn, strict) y `countNotesByApp`.
- [x] 5.2 Actualizar `test/notes.test.ts` (el filtro por app ya incluye `general`), `test/mcp.test.ts` y
  `test/mcp-sessions.test.ts` (ocho tools).
