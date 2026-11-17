## Context

`createNote` (`src/db/notes.ts:192-232`) calcula el embedding de `title + ' ' + body_md`, llama a
`findDuplicates` (`:170-188`: solo `deleted_at` y coseno ≥ `DUPLICATE_THRESHOLD` = 0.55, tope 5) y, con
`force`, se salta el chequeo sin dejar rastro. `DuplicateCandidate` es `{id, title, score}` (`:34-38`).

Mediciones con `Xenova/all-mpnet-base-v2` (el del repo, `src/db/embeddings.ts:12`), texto en español, hechas el
2026-11-16 sobre el servidor local (77 notas vivas) y sobre pares redactados a mano. **Son datos de hoy: el
fixture de tests no los usa como valores fijos** (ver D6).

| Medición | Resultado |
|---|---|
| Corpus real, 2926 pares | ≥ 0.55: 733 · ≥ 0.65: 217 · ≥ 0.70: 77 · ≥ 0.75: 26 · ≥ 0.80: 8 · ≥ 0.85: 3 |
| Real, pares ≥ 0.75 (26): mismo `kind` | 23 de 26; mismo `issue` no nulo: 6 de 26 |
| `sistema` genérica vs `decision` de ticket (4 pares) | 0.38 · 0.55 · 0.57 · 0.71 |
| Mismo contenido, redactado distinto (3 pares) | 0.60 · 0.67 · 0.97 |
| Mismo issue, título casi igual, cuerpo distinto (4 pares) | 0.79 · 0.81 · 0.85 · 0.77 |
| Mismo issue, títulos distintos | 0.57 · 0.77 |
| Sin relación | 0.28 |

Lectura: el coseno **no separa** «mismo tema» de «mismo contenido»: hay duplicados reales en 0.60–0.67 y notas
distintas en 0.71–0.81. Subir a 0.75 recorta el ruido (733 → 26 pares) a cambio de dejar pasar paráfrasis.

## Goals / Non-Goals

**Goals:** menos falsos positivos sin ocultar el duplicado obvio; que el agente decida con los metadatos a la
vista; que `force` deje motivo auditable; ajustar el umbral sin recompilar.

**Non-Goals:** mejorar el modelo o buscar un criterio sin coseno; deduplicar en `cortex_update`; atomicidad
frente a dos escrituras simultáneas; vista web del motivo; release e imagen.

## Decisions

**D1 — Umbral por defecto 0.75, por variable de entorno.** Es lo que propone el issue y la medición lo respalda
(0.9 % de pares en vez de 25 %). Costo declarado: paráfrasis a 0.60–0.67 dejan de avisarse. Cambiarlo es una
variable, no código: con 0.70 hay 77 pares en el corpus. `duplicateThreshold(env = process.env)` en
`src/db/constants.ts` devuelve el número; `undefined` o cadena vacía → 0.75; `Number(valor)` no finito, ≤ 0 o > 1
→ `throw new Error(...)` con el nombre de la variable, el valor y la pista «usá punto decimal». Se llama en cada
`createNote` (los tests cambian la variable sin reimportar el módulo) y una vez al arrancar en `src/index.ts`
(falla rápido, **antes de `warmup()`**, que puede tardar minutos). La constante `DUPLICATE_THRESHOLD = 0.55` se
elimina (único consumidor: `src/db/notes.ts:2,182`).

**D2 — Título parecido con `pg_trgm`, no con el coseno del título.** (a) `pg_trgm` **ya está instalada**: la
migración inicial hace `CREATE EXTENSION IF NOT EXISTS "pg_trgm"`
(`prisma/migrations/20261103225733_initial/migration.sql:11`) y `\dx` sobre el contenedor de test
(`pgvector/pgvector:pg16`, el mismo del compose) la lista en 1.6; Neon la soporta en PG16 (docs de Neon). No hay
migración de extensión. (b) Separa mejor: con `similarity(unaccent(a), unaccent(b))`, mismo issue y título casi
igual da 0.74–0.86 y títulos distintos del mismo issue 0.18–0.30; el coseno del título da 0.83 para dos títulos
distintos del mismo issue (el prefijo `MTD-380:` pesa). (c) El coseno del título obligaría a embeber el título de
cada nota candidata en cada escritura (los embeddings guardados son de título+cuerpo). Umbral de título: 0.6,
constante `TITLE_SIMILARITY_THRESHOLD`, no configurable (YAGNI). En las 41 parejas de mismo issue del corpus real
el máximo es 0.34: la regla no habría marcado nada hoy; es cobertura, no corrección de un dolor medido.

**D3 — Clasificador puro.** `classifyCandidate(c, input, T)` en `src/db/notes.ts` (exportada para tests):
entrada `{score, title_sim, kind, issue}` de la existente y `{kind, issue}` de la nueva; salida
`{matched_by: 'coseno'|'issue_y_titulo', same_issue, same_kind} | null`. Reglas, en este orden:
`same_issue` = ambos `issue` no nulos e iguales tras `trim().toLowerCase()`; `distinct` = `kind` distinto **o**
ambos `issue` no nulos y distintos; `requerido = T + (distinct ? 0.1 : 0)` (margen constante
`DUPLICATE_DISTINCT_MARGIN = 0.1`, no acumulable, no configurable); si `score >= requerido` →
`matched_by: 'coseno'`; si no, si `same_issue && title_sim >= 0.6` → `matched_by: 'issue_y_titulo'`; si no, `null`.
Si `T + 0.1 > 1` la regla de «distinto» nunca marca: aceptado, es consecuencia de un `T` alto. La normalización
de `issue` coincide con la que usa el change de filtros por issue (`lower(btrim(issue))`).

**D4 — Consulta.** `findDuplicates(prisma, vector, input)` trae, por SQL, las filas vivas con embedding cuyo
coseno ≥ `T` **o** con el mismo `lower(btrim(issue))` (solo si la nueva trae `issue`), con
`similarity(unaccent(title), unaccent($title)) AS title_sim`, `ORDER BY embedding <=> vector`, `LIMIT 50`; luego
filtra con `classifyCandidate`, ordena por `score` desc y corta a 5. `T` en SQL es el umbral base: el margen solo
puede restar candidatas, así que ningún candidato válido queda fuera del `WHERE`. Cada candidata:
`{id, title, score, app, kind, issue, updated_at, same_issue, same_kind, matched_by}`; `score` sigue siendo el
coseno aunque `matched_by` sea `issue_y_titulo` (el agente ve por qué una candidata con 0.62 apareció igual).
`matched_by` no lo pide el issue; lo agrego porque sin él una candidata bajo el umbral no se explica.

**D5 — El motivo vive en una columna nueva, no en una revisión inicial.** `note_revisions` tiene PK
`(note_id, rev)` y `updateNote` inserta la versión **vigente** con `rev = current.rev`
(`src/db/notes.ts:303-313`); una nota nace con `rev` 1 (`prisma/schema.prisma:19`). Una revisión inicial en `rev`
1 chocaría con la primera actualización (violación de PK), y además cambiaría el conteo del scenario vigente
«Dos actualizaciones producen dos revisiones» (`openspec/specs/notas/spec.md:43-48`: espera 2). Columna:
`notes.force_reason TEXT NULL` (`force_reason String?` en `prisma/schema.prisma`), migración SQL a mano
`ALTER TABLE "notes" ADD COLUMN "force_reason" TEXT;` y `migrate deploy` (CONTRIBUTING: nunca `migrate dev`). Es
aditiva y anulable: una versión vieja del código la ignora (reversión = volver el código; `DROP COLUMN` es
opcional). Se guarda recortado, también cuando `force: true` se usó sin que hubiera duplicados (el agente declaró
el motivo; no se ejecuta el chequeo solo para decidir si guardarlo). `NoteDto` y `toNoteDto` ganan
`force_reason: string | null`; `NoteRow` y los dos `SELECT` crudos (`:287-289`, `:389-391`) lo incluyen para que
el tipo no mienta. `cortex_list` ya devuelve todo el DTO menos `body_md` (`src/tools/mcp-server.ts:293`) y
`/api/notes/:id` devuelve `readNote`: no requieren código extra. Auditar los `force` = `cortex_list` y filtrar
`force_reason != null`; no se agrega filtro dedicado.

**D6 — Tests que no dependen de valores frágiles del modelo.** Dos capas. (1) Unitarios de `classifyCandidate` y
`duplicateThreshold` con números explícitos (sin modelo). (2) Integración con el modelo real, pero el umbral se
fija **relativo al coseno medido en el mismo test**: el test calcula `c = dot(embed(a), embed(b))` con el mismo
`embed()` del servidor y usa `CORTEX_DUPLICATE_THRESHOLD = c ± 0.02` (se espera una diferencia float32/float64 del
orden de 1e-6, no medida; 0.02 es holgado). Así «coseno ~0.73» deja de ser una constante del modelo: el caso del issue
(genérica + decisión de otro issue, que al umbral base se marcaría y con el margen no) se reproduce con el umbral
puesto justo debajo de `c`. Cada test de integración empieza con un guard que mide el fixture y falla con el
mensaje «fixture desactualizado: re-medir» si, p. ej., `c` no está entre 0.5 y 0.97 o la similitud de título no
está del lado que el test supone. Variable de entorno: se restaura en `finally` (Bun corre los archivos de test en
un mismo proceso).

**D7 — `reason` se valida en la capa de datos.** `validateCreate` (`src/db/notes.ts:149-168`) agrega, **al final**
(después de `author`, `app`, `kind`, `title`, `body_md`), `force && !reason?.trim()` →
`ValidationError('El campo reason es requerido cuando force es true', 'reason')`. Al final porque el test
`cortex_write con kind 'otro'…` (`test/mcp.test.ts:284-305`) manda `force: true` sin `reason` y espera el error de
`kind`; con el chequeo al final ese test sigue pasando sin tocarlo. La capa de datos valida porque ya no confía
en sus llamadores (comentario `src/db/notes.ts:253-254`). El handler de `cortex_write` ya traduce
`ValidationError` (`src/tools/mcp-server.ts:165-174`). El schema zod de la tool no marca `reason` como requerido:
lo es solo con `force`.

**D8 — Importador.** `src/import.ts:199-208` crea con `force: true` (decisión del importador, no del agente). Pasa
`reason: "importación inicial desde " + tag` (`tag` es `origen:<repo>:<path>`, definido en `src/import.ts:140`). Sin esto el importador fallaría con el requirement nuevo.

**D9 — Variable en Docker.** `docker-compose.yml` solo pasa al contenedor las variables que lista (`DATABASE_URL`,
`PORT`, `NODE_ENV`: líneas 24-26); una `CORTEX_DUPLICATE_THRESHOLD` exportada en el shell **no llegaría** al
servidor. Se agrega `CORTEX_DUPLICATE_THRESHOLD: ${CORTEX_DUPLICATE_THRESHOLD:-}` (vacía = default, por D1) y la
línea comentada en `.env.example`. El `docker run` del README documenta `-e CORTEX_DUPLICATE_THRESHOLD=...`.

## Risks / Trade-offs

- **Paráfrasis sin aviso** (D1): riesgo aceptado y reversible por variable. Mitigación en la skill: buscar con
  `cortex_search` antes de crear.
- **Contrato roto** (D7): cada agente con `force: true` sin `reason` falla hasta actualizar su skill. El mensaje
  de error dice qué falta.
- **Color de la medición**: la baseline de pares es de un corpus de un solo equipo (77 notas, casi todas del
  mismo dominio); no es una evaluación con etiquetas de «duplicado real».
- **Choque de merge** con #13+#14 y #16 en `src/tools/mcp-server.ts` y `src/db/notes.ts` (hunks distintos) y con
  #16 en `src/index.ts` (bloque `import.meta.main`).
- **Migración**: `20261116220000_notes_force_reason` (el change de filtros usa `20261116210000`); el orden entre
  ambas no importa.

## Migration Plan

`migrate deploy` al arrancar el contenedor (`docker-entrypoint.sh:14`); aditiva y anulable, sin bloqueo largo.
Reversión: volver a la imagen anterior (ignora la columna). `DROP COLUMN "force_reason"` solo si se quiere
limpiar.
