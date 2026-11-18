# Design — filtros por `issue` y `tags`

## Context

Ver `proposal.md - Why`. Estado verificado en `origin/main` (f9d5d81):

- `hybridSearch` (`src/db/search.ts:69`) arma `appCond`/`kindCond` con `Prisma.sql` y los repite en las dos
  consultas (`:75-76`, usados en `:86-87` y `:105-106`); ambas consultas ya filtran en SQL antes del
  `LIMIT 50`. Agregar condiciones ahí restringe las dos ramas sin tocar la fusión.
- `rrfFusion` (`src/db/search.ts:28-63`) solo arrastra `id`, `title`, `body_md`; para exponer `issue` hay
  que seleccionarlo en las dos consultas y llevarlo por la fusión.
- `listNotes` (`src/db/notes.ts:349-371`) usa `prisma.note.findMany` y filtra `tags` en memoria
  (`:366-368`, igualdad exacta por tag, AND).
- `Note.tags` es `jsonb` (`prisma/migrations/20261103225733_initial/migration.sql:20`): el operador `@>`
  expresa «contiene todos» con igualdad exacta por elemento, la misma semántica que
  `n.tags.includes(tag)`.
- `cortex_update` hoy no tiene `issue` en el schema (`src/tools/mcp-server.ts:186-208`) ni en `UpdateInput`.

## Goals / Non-Goals

- **Goals**: rescatar por ticket de forma determinista; que lo documentado (`tags` en búsqueda) exista;
  poder corregir/quitar `issue`; que README, spec y código coincidan.
- **Non-Goals**: prefijo de proyecto, índice GIN de tags, `issue` en `note_revisions`, normalizar `issue`
  al crear, tocar `lexicalSearch`, publicar imagen.

## Decisions

- **D1 — Igualdad exacta normalizada.** El filtro compara `lower(btrim(issue)) = lower(<valor recortado>)`.
  El valor del filtro se recorta con `trim()` en TypeScript antes de ir como parámetro. Alternativa del
  ticket: `lower(issue) = lower($1)`; se agrega `btrim` porque no pude inspeccionar la base de producción
  (Neon inaccesible durante la exploración) y una fila con espacios en los extremos —`issue` es formato
  libre y `createNote` lo guarda tal cual (`src/db/notes.ts:221`)— quedaría invisible al filtro. Costo:
  cero; el índice se declara sobre la misma expresión.
- **D2 — Sin prefijo.** El issue pide el prefijo (`MTD-%`) como opcional. Se descarta en este change:
  meter `ILIKE 'MTD-%'` bajo el mismo parámetro `issue` mezcla dos semánticas (igual vs. empieza-por) y
  `%`/`_` serían comodines en valores como URLs. Si se necesita, parámetro nuevo `issue_prefix` con
  escape de comodines, en otro change.
- **D3 — Una sola expresión SQL.** La expresión `lower(btrim(issue))` se define una vez en
  `src/db/constants.ts` (constante exportada `ISSUE_NORMALIZED_SQL`, p. ej. `Prisma.raw('lower(btrim(issue))')`)
  y la usan `search.ts` y `notes.ts`; la migración lleva el mismo texto. Razón: el planner solo usa el índice
  si la expresión de la consulta coincide con la del índice; un test lo comprueba (task 5.6).
- **D4 — `cortex_list` por prefiltro de ids.** `prisma.note.findMany` no expresa `lower(btrim())` y su
  `mode: 'insensitive'` no usa el índice. Con `issue` presente, `listNotes` ejecuta primero
  `SELECT id FROM notes WHERE deleted_at IS NULL AND <expr> = lower(${issue})` y agrega
  `id: { in: ids }` al `where` existente. Sin `issue`, el camino actual no cambia. Alternativa descartada:
  filtrar en memoria como `tags` — funciona pero deja el índice sin consumidor en list.
- **D5 — `tags` en búsqueda con `@>`.** Condición `AND tags @> ${JSON.stringify(tags)}::jsonb` en las dos
  consultas, solo cuando `tags` trae al menos un elemento (`[]` o ausente = sin filtro, igual que
  `listNotes`, `src/db/notes.ts:366`). `listNotes` no se toca.
- **D6 — `/api/search`: `tags=a,b`.** El valor se parte por coma, cada pieza `trim()`, se descartan las
  vacías. Un tag que contenga coma no se puede filtrar por REST (sí por MCP, que recibe un array). Query
  schema de Elysia: `tags: t.Optional(t.String())` e `issue: t.Optional(t.String())` junto a los
  existentes (`src/index.ts:32-37`). Comportamiento de `tags` repetido (`tags=a&tags=b`) no se promete:
  no se verificó qué hace Elysia 1.4.31 con claves repetidas; QA lo observa (task 7.4) y lo deja escrito.
- **D7 — `issue` vacío en filtros = sin filtro.** Igual que `app`/`kind`/`author` (se evalúan por
  verdad en `src/db/search.ts:75`, `src/db/notes.ts:356-358`). Un `issue` de solo espacios, tras `trim()`,
  también. Alternativa descartada: rechazar con error — rompería la regla común a los otros filtros.
- **D8 — `cortex_update` y `issue`.** `UpdateInput.issue?: string | null`. `undefined` = no cambia;
  `null` = quita; texto = se guarda recortado; texto vacío o solo espacios = `ValidationError` con
  `field: 'issue'` que dice «usa null para quitarlo». En el schema de la tool:
  `z.string().nullable().optional()` (JSON Schema `type: ["string","null"]`, verificado con
  `z.toJSONSchema` de zod 4.6.7). La actualización solo de `issue` pasa por el mismo camino que cualquier
  otra: inserta revisión de la versión vigente y avanza `rev` (`src/db/notes.ts:303-334`). `note_revisions`
  no tiene columna `issue`: el valor anterior no queda recuperable (ver riesgos).
- **D9 — Migración.** Archivo `prisma/migrations/20261116210000_notes_issue_idx/migration.sql` con
  `CREATE INDEX "notes_issue_idx" ON "notes" (lower(btrim("issue")));`. Escrita a mano y aplicada con
  `migrate deploy` (CONTRIBUTING.md, sección Desarrollo local); nunca `migrate dev`. `schema.prisma` no
  declara el índice (Prisma no expresa índices funcionales) y su comentario de `:30-34` se amplía para
  nombrarlo. Reversión: `DROP INDEX "notes_issue_idx";`.
- **D10 — Resultados.** `SearchResult` gana `issue: string | null` (`src/db/search.ts:10-16`). Es aditivo:
  los consumidores que ignoran campos extra no se rompen.

## Risks / Trade-offs

- **Búsqueda semántica con filtro selectivo** (medido, no supuesto): en un Postgres 16 con pgvector 0.8.7
  y 5.000 filas (5 con `issue = 'MTD-1'`) con HNSW, la consulta con el filtro devolvió las 5 con el plan
  que elige el planner (usa el índice de `issue`); al forzar el plan por HNSW (`enable_sort=off`)
  devolvió 0, porque HNSW trae sus candidatos y filtra después. Con el filtro de `tags` (sin índice) el
  planner eligió Seq Scan y devolvió las 5, también con 50.000 filas. Conclusión: hoy es correcto porque el
  planner no usa HNSW con filtros selectivos en un corpus de este tamaño; el índice de `issue` no es solo
  de velocidad, también evita ese plan. El problema ya existe para `app`/`kind`. Se declara; no se
  mitiga aquí.
- **`cortex_update` solo de `issue` no deja rastro del valor anterior** (como `app`/`kind`, comentario en
  `src/db/notes.ts:320-322`). Aceptado; pasarlo a `note_revisions` exige columna nueva.
- **Clientes MCP y `type: ["string","null"]`**: un cliente que no entienda tipos-unión podría no ofrecer
  `null`. No verificado con Hermes/Claude Code; el test MCP del repo sí lo ejerce con el SDK oficial.
- **Cambio de forma del JSON de búsqueda** (campo `issue` nuevo): aditivo; declarado en D10.
- **Archivos compartidos con otros changes en paralelo**: ver `propuesta.md` §3 (orden de merge).
