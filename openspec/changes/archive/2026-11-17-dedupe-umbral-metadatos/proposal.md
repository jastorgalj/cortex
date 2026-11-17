## Why

En dos semanas de uso real, `cortex_write` respondió `similar_exists` 32 veces y en 28 (87 %) el agente reintentó
con `force: true`: la alerta dejó de filtrar. Medido con el modelo del repo sobre las 77 notas vivas del
servidor: **733 de 2926 pares (25 %) superan 0.55**, contra 26 (0.9 %) a 0.75. Hoy el criterio es solo el
coseno de `title + body_md` contra 0.55 (`src/db/constants.ts:10`, `src/db/notes.ts:170-188`), sin mirar
`app`, `kind` ni `issue`, y `force: true` no deja rastro (`src/db/notes.ts:202-207`).

## What Changes

- **Umbral configurable.** `CORTEX_DUPLICATE_THRESHOLD` (número en (0, 1]); sin la variable o vacía, 0.75. Se
  lee en cada escritura; un valor inválido hace fallar el arranque con un mensaje que nombra la variable.
- **Metadatos en el criterio.** Distinto `kind`, o distinto `issue` (ambos no nulos), exigen coseno ≥ umbral
  + 0.1. Mismo `issue` no nulo y título casi igual (`pg_trgm`, similitud ≥ 0.6) marca duplicado aunque el
  coseno sea menor.
- **Candidatas enriquecidas.** Cada candidata trae `app`, `kind`, `issue`, `updated_at`, `same_issue`,
  `same_kind` y `matched_by`, para decidir sin un `cortex_read`.
- **`force: true` exige `reason`.** Vacío o ausente se rechaza nombrando `reason`; con motivo, la nota se crea y
  el motivo queda en la columna nueva `notes.force_reason` (migración aditiva), visible en `cortex_read`,
  `cortex_list` y `GET /api/notes/:id`.
- **Importador.** `src/import.ts` crea con `force: true`; pasa a mandar un `reason` fijo para no romperse.
- **Docs y skills** alineados (README, CONTRIBUTING, las dos skills, compose y `.env.example`).

## Capabilities

### New Capabilities

Ninguna.

### Modified Capabilities

- `notas`: se modifica «Creación con detección de duplicados» (ya no fija 0.55) y se agregan seis
  requirements: umbral configurable, más coseno por distinto `kind`/`issue`, mismo `issue` y título casi igual,
  candidatas enriquecidas, `force` exige motivo y el motivo queda consultable.

## Impact

- Código: `src/db/constants.ts`, `src/db/notes.ts`, `src/tools/mcp-server.ts`, `src/index.ts`, `src/import.ts`,
  `prisma/schema.prisma`, migración nueva, `docker-compose.yml`, `.env.example`.
- **Contrato MCP roto a propósito:** un agente que hoy llama `cortex_write` con `force: true` sin `reason`
  recibirá error hasta que su skill se actualice. Es lo que pide el issue (#10).
- Un `similar_exists` menos frecuente también significa **duplicados por paráfrasis que ya no se avisan**
  (medido: 0.60–0.67 entre redacciones distintas del mismo contenido). Se mitiga con `cortex_search` antes de
  escribir (skill) y se corrige con la variable de entorno, sin recompilar.
- Fuera de alcance: publicar imagen (GHCR), release y subir versión; deduplicar en `cortex_update`;
  deduplicación atómica ante escrituras concurrentes (hoy tampoco existe); mostrar `force_reason` en la
  vista web HTML.
