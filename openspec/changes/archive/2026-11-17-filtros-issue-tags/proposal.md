# Proposal — Filtros por `issue` y `tags` en listado y búsqueda

## Why

Los agentes trabajan por ticket y necesitan «todo lo que se sabe del ticket X». El campo `issue` se
guarda (`prisma/schema.prisma:18`) pero no se puede filtrar: `ListFilter` (`src/db/notes.ts:104-109`) y
`SearchFilter` (`src/db/search.ts:18-21`) solo conocen `app`/`kind`(/`tags`/`author` en list), así que el
agente busca el identificador como texto y depende de que esté escrito en el cuerpo. Tampoco se puede
corregir `issue` después de crear la nota (`UpdateInput`, `src/db/notes.ts:93-102`). (GitHub #13)

Además hay una discrepancia entre contrato y código (GitHub #14): el spec vigente ya promete que
`cortex_search` filtra por tags (`openspec/specs/busqueda/spec.md:45`) y que `GET /api/search` acepta
`tags` (`openspec/specs/servidor-mcp/spec.md:42`), y el README lo repite (`README.md:60`), pero ni la tool
(`src/tools/mcp-server.ts:49-57`), ni la ruta (`src/index.ts:32-37`), ni `hybridSearch`
(`src/db/search.ts:75-76`) lo implementan. Peor: el schema de la tool descarta la clave desconocida en
silencio (verificado con zod 4.6.7: `parse({q, tags})` devuelve `{q}`), así que un agente que pasa `tags`
recibe resultados sin filtrar creyendo que sí lo están. Decisión del usuario: implementar (opción A), no
recortar la documentación.

## What Changes

- **`issue` como filtro** en `cortex_list`, `cortex_search` y `GET /api/search`: igualdad exacta sin
  distinguir mayúsculas ni espacios en los extremos. Sin prefijo ni comodines (ver design D2).
- **`tags` como filtro de búsqueda** en `cortex_search` y `GET /api/search` (`tags=a,b`), semántica AND
  idéntica a `cortex_list`, aplicada en las dos ramas (léxica y semántica) antes del `LIMIT`.
- **`issue` en los resultados de búsqueda** (`SearchResult` gana `issue: string | null`; cambio aditivo del
  JSON de `cortex_search` y `/api/search`).
- **`cortex_update` acepta `issue`**: texto para corregirlo, `null` para quitarlo, omitido = sin cambio.
- **Índice** `notes_issue_idx` sobre `lower(btrim(issue))` en una migración SQL nueva (solo SQL, como el
  HNSW; `schema.prisma` no puede expresarlo).
- **Documentación**: `README.md`, `skills/cortex-mcp/SKILL.md` y los specs coinciden con el código.

## Capabilities

### New Capabilities

Ninguna.

### Modified Capabilities

- `busqueda`: «Búsqueda híbrida con fusión de rankings» (el resultado incluye `issue`) y «Filtros por app,
  kind y tags» (semántica AND de tags, ahora real en búsqueda); requirements nuevos para el filtro por
  `issue`, para que los filtros restrinjan ambas ramas y para el índice.
- `notas`: requirement nuevo «La actualización puede corregir o quitar el issue».
- `servidor-mcp`: «API REST de solo lectura» (agrega `issue` a los parámetros); requirements nuevos para el
  formato de los filtros en `/api/search` y para el schema de las tools.

## Fuera de alcance

- Filtro por prefijo de proyecto (`MTD-%`): `%` y `_` son comodines de `LIKE` y una URL de issue puede
  contenerlos; el prefijo queda para un issue aparte (parámetro propio `issue_prefix`).
- Índice GIN sobre `tags` (el corpus es de megabytes; ver design, riesgos).
- `lexicalSearch` (`src/db/notes.ts:443`): solo la usan los tests (grep en `src/` y `test/`), no las tools.
- Guardar `issue` en `note_revisions` (la corrección de `issue` no deja rastro del valor anterior, igual que
  `app`/`kind`, ver `src/db/notes.ts:320-322`).
- Normalizar `issue` al crear (`cortex_write`): el filtro ya tolera espacios con `btrim`.
- Publicación de imagen, release y bump de versión.
