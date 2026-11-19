## ADDED Requirements

### Requirement: La búsqueda por `app` incluye `general` y expone la app del resultado

`cortex_search` y `GET /api/search` con `app` SHALL filtrar las dos ramas (léxica y semántica) por esa app
y por `general`, salvo `include_general: false` (en REST, `include_general=false`). Cada resultado SHALL
incluir su `app` junto a `id`, `title`, `snippet`, `score`, `origin` e `issue`. Razón: el mismo criterio
que el listado, y el agente distingue de qué app vino cada nota sin un `cortex_read` extra.

#### Scenario: la búsqueda encuentra la nota de `general`

GIVEN una nota con `app: "general"` y otra con `app: "backend"` que mencionan «custodia de garantías»
WHEN se llama `cortex_search` con `q: "custodia de garantías"` y `app: "backend"`
THEN el resultado incluye las dos notas y cada una trae su `app`

#### Scenario: include_general false en la búsqueda

GIVEN las mismas dos notas
WHEN se llama `cortex_search` con `app: "backend"` e `include_general: false`
THEN el resultado no incluye la nota con `app: "general"` y las devueltas tienen `app: "backend"`

#### Scenario: REST con include_general=false

GIVEN las mismas dos notas
WHEN se llama `GET /api/search?q=custodia&app=backend&include_general=false`
THEN la respuesta no incluye la nota con `app: "general"`
