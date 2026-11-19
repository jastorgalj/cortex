# Proposal — Taxonomía de `app`: vocabulario, alias y `general` transversal

## Why

`app` es texto libre y hoy mezcla capas (`frontend`, `backend`), nombres de producto y `general`: nueve
valores distintos en ~80 notas. Dos consecuencias medidas sobre el corpus real (GitHub #12):

- `cortex_list(kind: "regla", app: "backend")` devuelve `[]` porque las reglas transversales viven en
  `app: "general"`, mientras la skill manda empezar por ahí. El agente concluye que no hay reglas.
- El mismo sistema aparece bajo valores distintos (capa vs. repo), así que filtrar por `app` pierde notas.

`app` no se valida en ningún lado (`src/db/notes.ts:173-175` solo exige no vacío) y los filtros comparan
por igualdad exacta (`src/db/notes.ts:504-509`, `src/db/search.ts:83`).

## What Changes

- **Vocabulario configurable**: `CORTEX_APPS` (lista canónica) y `CORTEX_APP_ALIASES` (JSON
  `{"viejo":"canónico"}`); `CORTEX_APP_MODE` = `warn` (default: acepta y devuelve `warnings`) o `strict`
  (rechaza con `ValidationError` listando los válidos). Sin `CORTEX_APPS` no hay vocabulario y todo valor
  se acepta, como hasta hoy.
- **Normalización**: `trim().toLowerCase()` en escritura, corrección, filtros y conteos. El valor
  persistido es siempre el canónico; un alias no migra datos.
- **`general` transversal**: los filtros por `app` de `cortex_list`, `cortex_search` y `/api/search`
  incluyen `app: "general"` salvo `include_general: false`. Cada resultado de búsqueda trae su `app`.
- **Descubrimiento**: tool `cortex_apps` y endpoint `GET /api/apps` con cada app en uso y su conteo, más
  la lista canónica, el modo y los alias vigentes.
- **Documentación**: el schema de las tools describe el vocabulario cuando está configurado; README,
  `.env.example` y `skills/cortex-mcp/SKILL.md` quedan coherentes con `general`.

Fuera de alcance (declarado): `author` sigue siendo texto libre (el issue lo menciona como punto 5), no se
acepta `app` como array (punto 3) y no hay script de migración de datos (punto 6). Los tres son cambios
separados; este PR resuelve los criterios de aceptación del issue sin tocar datos existentes.

## Capabilities

### New Capabilities

Ninguna.

### Modified Capabilities

- `notas`: la escritura normaliza y valida `app`; los listados incluyen `general` por defecto.
- `busqueda`: el filtro por `app` incluye `general` y el resultado expone su `app`.
- `servidor-mcp`: nueva tool `cortex_apps`, `include_general` en las tools y `GET /api/apps`.
