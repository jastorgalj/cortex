# Tasks — filtros por `issue` y `tags`

> Entorno (todos los grupos): worktree `C:/Users/jastorga/Desarrollo/infra-local/cortex/.worktrees/gh-13-14`,
> rama `feat/filtros-issue-tags`. Postgres propio en `127.0.0.1:5441`. Comandos de prueba:
> `TEST_DATABASE_URL=postgresql://cortex:cortex_dev@127.0.0.1:5441 bun test` y `bun run typecheck`.
> **Modelo ONNX**: la descarga desde Hugging Face se corta (`ECONNRESET`) y deja cinco archivos de test en
> rojo sin que sea un fallo del código. Con el modelo en una carpeta local, la baseline es **73 pass / 0 fail**.
> Usa `MODEL_CACHE_DIR=C:/Users/jastorga/.model-cache/gh-13-14` (copia del modelo ya descargada; si no
> existe, cópiala del volumen del contenedor con `docker cp cortex:/app/.model-cache/. <destino>`, solo
> lectura). Nunca el 5433, ni Neon, ni el contenedor `cortex` (:3091). Los tests existentes usan los puertos
> fijos 13091 (`mcp.test.ts`), 13092 (`api.test.ts`) y 13093 (`delete.test.ts`): otra corrida de `bun test`
> en paralelo desde otro worktree los pisa; no corras dos a la vez.
> Prohibido `prisma migrate dev` (borraría el índice HNSW y el parcial; ver CONTRIBUTING.md).

## 1. Migración y esquema

- [x] 1.1 Crear `prisma/migrations/20261116210000_notes_issue_idx/migration.sql` con exactamente
  `CREATE INDEX "notes_issue_idx" ON "notes" (lower(btrim("issue")));` y un comentario de una línea que
  diga que es SQL a mano. No tocar `20261103225733_initial` (una migración aplicada no se edita).
- [x] 1.2 En `prisma/schema.prisma`, ampliar el comentario de `:30-34` para nombrar `notes_issue_idx` junto
  al HNSW y al parcial de `deleted_at` como índices que viven solo en el SQL. No agregar `@@index` para
  `issue` (Prisma no expresa índices funcionales).
- [x] 1.3 Aplicar con `bunx prisma migrate deploy` (nunca `migrate dev`) sobre `127.0.0.1:5441` y comprobar
  que `bunx prisma migrate diff --from-url <cortex_test en 5441> --to-schema-datamodel prisma/schema.prisma --script`
  sigue diciendo `-- This is an empty migration.` (hoy lo dice; si deja de decirlo, detener y reportar).

## 2. Capa de datos

- [x] 2.1 Definir la expresión normalizada una sola vez (p. ej. `ISSUE_NORMALIZED_SQL = Prisma.raw('lower(btrim(issue))')`
  en `src/db/constants.ts`) y usarla en `src/db/search.ts` y `src/db/notes.ts`; el texto debe coincidir con el de
  la migración 1.1.
- [x] 2.2 `src/db/search.ts`: agregar `issue?: string` y `tags?: string[]` a `SearchFilter` (`:18-21`); agregar
  `issue: string | null` a `SearchResult` (`:10-16`). Construir `issueCond` (solo si `filter.issue?.trim()` es
  no vacío: `AND <expr> = lower(${trimmed})`) y `tagsCond` (solo si `filter.tags?.length`:
  ``AND tags @> ${JSON.stringify(filter.tags)}::jsonb``) junto a `appCond`/`kindCond` (`:75-76`), e insertarlos
  en la consulta léxica (`:81-90`) y en la semántica (`:97-109`).
- [x] 2.3 `src/db/search.ts`: seleccionar `issue` en las dos consultas, llevarlo por `rrfFusion` (`:28-63`,
  incluido el tipo `Entry`) y devolverlo en el `map` final (`:121-127`).
- [x] 2.4 `src/db/notes.ts`: agregar `issue?: string` a `ListFilter` (`:104-109`). En `listNotes` (`:349`), si el
  `issue` recortado no es vacío, ejecutar primero el `SELECT id ... WHERE deleted_at IS NULL AND <expr> = lower(${issue})`
  y agregar `id: { in: ids }` al `where`; sin `issue` el camino actual no cambia (design D4). No modificar
  el filtro de `tags` en memoria (`:366-368`).
- [x] 2.5 `src/db/notes.ts`: agregar `issue?: string | null` a `UpdateInput` (`:93-102`). En `updateNote`, junto a
  la validación de `app` (`:261-263`), lanzar `ValidationError('...usa null para quitarlo', 'issue')` si
  `input.issue` es string y `trim()` queda vacío (antes de cualquier lectura o transacción). En el
  `tx.note.update` (`:323-334`) escribir `issue` solo cuando `input.issue !== undefined`: `null` → `null`,
  texto → `trim()`.
- [x] 2.6 No modificar `lexicalSearch` (`:443`) ni `createNote`.

## 3. Tools y REST

- [x] 3.1 `src/tools/mcp-server.ts`, `cortex_search` (`:46-67`): agregar `issue: z.string().optional()` y
  `tags: z.array(z.string()).optional()` con `.describe()` (tags: «AND: la nota debe tener todos»), pasarlos a
  `hybridSearch`, y actualizar la descripción de la tool (`:48`) para que diga que devuelve también `issue`.
- [x] 3.2 `cortex_list` (`:277-300`): agregar `issue: z.string().optional()` con `.describe()` y pasarlo a `listNotes`.
- [x] 3.3 `cortex_update` (`:183-274`): agregar `issue: z.string().nullable().optional()` con `.describe()`
  («omite para no cambiar; null para quitarlo») y pasarlo a `updateNote`. El `ValidationError` ya se
  traduce a «parámetro inválido 'issue'» por el `catch` existente (`:259-268`).
- [x] 3.4 `src/index.ts` `/api/search` (`:24-39`): agregar `issue` y `tags` como `t.Optional(t.String())` al
  query schema; partir `tags` por coma, `trim()` a cada elemento y descartar vacíos (design D6); pasar
  `{ app, kind, issue, tags }` a `hybridSearch`. No tocar la rama `if (!q)`.

## 4. Documentación

- [x] 4.1 `README.md:60`: la fila de `cortex_search` pasa a decir filtros opcionales por `app`, `kind`, `issue` y
  `tags` (AND). `README.md:64`: la fila de `cortex_list` agrega `issue`. `README.md:63`: la fila de
  `cortex_update` menciona que puede corregir o quitar `issue`. `README.md:44`: la fila `issue` agrega que
  se puede filtrar y corregir.
- [x] 4.2 `skills/cortex-mcp/SKILL.md:32`: en la línea «Empiezo una tarea en <app>» agregar, en la línea
  siguiente del bloque, `Retomo un ticket → cortex_list o cortex_search con issue=<ID>`. Sin otros cambios a
  la skill.
- [x] 4.3 No tocar `openspec/specs/**` a mano: se sincronizan al archivar (task 8.2).

## 5. Tests (los escribe el coder junto al código)

- [x] 5.0 Las notas de fixture con cuerpo casi idéntico se crean con `force: true`: sin él `createNote`
  responde `similar_exists` (similitud ≥ 0.55, `src/db/notes.ts:202-207`) y la nota no existe.
- [x] 5.1 `test/search.test.ts`: `hybridSearch` con `issue` restringe a las notas del issue, filtrando con
  `"ABC-1"` y con `"abc-1"` sobre notas guardadas como `ABC-1`, con `"  ABC-1"` y contra una nota guardada con `" ABC-1 "`; `issue: "MTD-38"` no trae `MTD-380`;
  `issue: "   "` devuelve lo mismo que sin el parámetro. Cubre los scenarios de «Filtro por issue».
- [x] 5.2 `test/search.test.ts`: `hybridSearch` con `tags` (uno, dos, `[]`) cubre los tres scenarios de tags;
  y un test con consulta conceptual (sin palabras del título) que prueba que la nota sin el tag no entra por
  la rama semántica (`origin` nunca `semantic`/`both` para ella). Cubre «Los filtros restringen ambas ramas».
- [x] 5.3 `test/search.test.ts`: cada resultado trae `issue` (valor o `null`). Cubre «El resultado expone el issue».
- [x] 5.4 `test/notes.test.ts`: `listNotes` con `issue` (mayúsculas, espacios, exacto vs prefijo, en blanco,
  combinado con `tags`); `updateNote` con `issue` nuevo (rev+1, historial conserva rev 1), con `null`, omitido
  y con `""`/`"   "` (rechaza, `rev` y `cortex_history` sin cambios, mensaje nombra `issue` y `null`).
- [x] 5.5 `test/mcp.test.ts`: `tools/list` declara `issue`/`tags` en `cortex_search`, `issue` en `cortex_list`
  y `issue` con `string` y `null` en `cortex_update`; `cortex_update` con `issue: null` por el cliente MCP real
  quita el issue; `cortex_search` con `tags` filtra (el caso del bug #14: antes devolvía todo).
- [x] 5.6 `test/notes.test.ts` o `test/search.test.ts`: comprobar con `SELECT indexdef FROM pg_indexes WHERE
  indexname = 'notes_issue_idx'` que el índice existe con `lower(btrim(issue))`, y con `SET enable_seqscan = off`
  + `EXPLAIN` de la consulta del filtro que el plan nombra `notes_issue_idx` (misma conexión; usar
  `prisma.$transaction` para que el `SET` y el `EXPLAIN` compartan sesión).
- [x] 5.7 `test/api.test.ts`: `/api/search?q=...&tags=area:x`, `&tags=area:x,repo:y`, `&tags=,area:x,`,
  `&issue=abc-1`; la respuesta trae `issue`; los ids coinciden con `hybridSearch` directo con los mismos
  filtros.
- [x] 5.8 **Sabotaje (obligatorio, uno por regla, con la salida real en el handoff).** Para cada fila, aplicar el
  sabotaje, correr el test indicado, confirmar que FALLA, y revertir:

  | Sabotaje | Test que debe fallar |
  |---|---|
  | quitar `issueCond` de la consulta semántica solamente | 5.1/5.2 (búsqueda por issue/tags rama semántica) |
  | quitar `tagsCond` de la consulta léxica solamente | 5.2 |
  | cambiar `@>` por `?|` (cualquiera en vez de todos) | 5.2 (dos tags) |
  | quitar `btrim` de la expresión de las consultas (no del índice) | 5.1 (espacios) y 5.6 (EXPLAIN) |
  | quitar `lower` del valor comparado | 5.1 (mayúsculas) |
  | `listNotes` ignora `issue` | 5.4 |
  | `updateNote` convierte `null` en «sin cambio» | 5.4 y 5.5 (null) |
  | `updateNote` acepta `""` | 5.4 |
  | `/api/search` ignora `tags` | 5.7 |
  | quitar `issue` del `SELECT` de una de las dos consultas | 5.3 |

## 6. Compuertas del coder

- [x] 6.1 `bun run typecheck` limpio.
- [x] 6.2 `bunx prisma migrate diff` (1.3) sigue vacío y `bunx prisma migrate deploy` sobre una base ya migrada
  responde sin migraciones pendientes.
- [x] 6.3 Tests nuevos en verde (5.1–5.7) antes de pasar a QA; el sabotaje 5.8 ya revertido
  (`git diff` sobre `src/` no contiene ningún sabotaje).

## 7. Verificación de QA (sin browser: server real del worktree + curl + cliente MCP)

El server se levanta desde el worktree con `DATABASE_URL` a una base **propia** del contenedor 5441
(p. ej. `cortex_qa`, creada con `CREATE DATABASE`, migrada con `migrate deploy`) y `PORT=13141`, con
`MODEL_CACHE_DIR` como arriba. Un script a archivo lo lanza en segundo plano con el PID en un archivo y
lo detiene al terminar. Nunca el `:3091`.

- [x] 7.1 Sembrar con el cliente MCP real (script a archivo con el SDK del repo) cuatro notas:
  A (`issue: "QA-1"`, tags `["area:x","repo:y"]`), B (`issue: "qa-1"`, tags `["area:x"]`),
  C (`issue: "QA-10"`, sin tags), D (sin `issue`, sin tags); mismo vocabulario en las cuatro («tasa
  preferencial de cuotas») para que todas sean encontrables. Las cuatro se escriben con `force: true`
  (con ese vocabulario común el servidor respondería `similar_exists`).
- [x] 7.2 `curl "http://127.0.0.1:13141/api/search?q=tasa&issue=Qa-1"` → ids {A, B}; `...&issue=QA-10` → {C};
  `...&issue=%20qa-1%20` → {A, B}; `...&issue=` (vacío) → las cuatro. Cada objeto trae `issue`.
- [x] 7.3 `curl ".../api/search?q=tasa&tags=area:x"` → {A, B}; `tags=area:x,repo:y` → {A}; `tags=,area:x,` → {A, B};
  `tags=area:x&issue=qa-1` → {A, B}; `tags=nada:z` → `[]`.
- [x] 7.4 Registrar (sin juzgar) el status y cuerpo de `curl ".../api/search?q=tasa&tags=area:x&tags=repo:y"`
  (clave repetida), para dejarlo documentado.
- [x] 7.5 Con el cliente MCP: `cortex_search {q, tags:["area:x"]}` → {A, B} (antes del cambio devolvía las
  cuatro); `cortex_list {issue:"qa-1"}` → {A, B}; `cortex_update {id: D, issue:"QA-1", author}` → D aparece en
  `cortex_list {issue:"qa-1"}`; `cortex_update {id: D, issue:null, author}` → ya no; `cortex_update {id: D,
  issue:"", author}` → error que nombra `issue` y `null`, `rev` sin cambio.
- [x] 7.6 Con `psql` (contenedor 5441) sobre `cortex_qa`: `SELECT indexdef FROM pg_indexes WHERE
  indexname='notes_issue_idx'` devuelve la expresión `lower(btrim(issue))`.
- [x] 7.7 Entregar `qa_results.json` con cada caso 7.2–7.6: comando, esperado, obtenido, PASA/FALLA/OMITIDO.

## 8. Verificación final y cierre (suite completa solo aquí)

- [x] 8.1 `bun run typecheck` y la suite completa `bun test` con `TEST_DATABASE_URL` y `MODEL_CACHE_DIR`
  como arriba: baseline 73 pass / 0 fail + los tests nuevos, 0 fail.
- [x] 8.2 `openspec validate filtros-issue-tags --type change --strict` sin errores ni warnings; después
  `openspec archive filtros-issue-tags` (sincroniza los tres specs) y `openspec validate --specs` sin errores.
- [x] 8.3 `grep -rn "tags" openspec/specs/busqueda openspec/specs/servidor-mcp` coincide con README y código:
  `cortex_search` y `/api/search` aceptan `tags`; ninguna frase de spec o README promete un filtro que el
  código no tiene (criterio del issue #14: «README, spec y código coinciden»).
- [x] 8.4 `git diff --stat origin/main` toca solo: `src/db/search.ts`, `src/db/notes.ts`, `src/db/constants.ts`,
  `src/tools/mcp-server.ts`, `src/index.ts`, `prisma/schema.prisma`, la migración nueva, los cuatro archivos
  de test nombrados, `README.md`, `skills/cortex-mcp/SKILL.md` y `openspec/**`.
