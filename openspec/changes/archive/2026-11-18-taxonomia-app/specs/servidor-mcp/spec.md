## ADDED Requirements

### Requirement: `cortex_apps` expone el vocabulario y los conteos

El servidor MCP SHALL ofrecer la tool `cortex_apps`, sin argumentos, que devuelva cada app con notas no
borradas y su conteo (`{ app, count }`, ordenadas por app) más el vocabulario vigente: `canonicas`
(`CORTEX_APPS` más `general`), `modo` y `aliases`. Razón: el agente elige la app mirando qué existe hoy,
no inventando un valor.

#### Scenario: conteo por app

GIVEN dos notas con `app: "general"` y una con `app: "backend"`, todas no borradas
WHEN se llama `cortex_apps`
THEN la respuesta trae `general` con conteo 2 y `backend` con conteo 1

#### Scenario: el vocabulario declarado se ve en la tool

GIVEN `CORTEX_APPS: "backend,console"` y `CORTEX_APP_ALIASES: {"back":"backend"}`
WHEN se llama `cortex_apps`
THEN `canonicas` incluye `backend`, `console` y `general`, y `aliases` mapea `back` a `backend`

#### Scenario: una nota borrada no cuenta

GIVEN una nota con `app: "huella"` borrada lógicamente
WHEN se llama `cortex_apps`
THEN `huella` no aparece en `apps` (o aparece con conteo 0 solo si tiene otra nota vigente)

### Requirement: Descubrimiento por REST y `include_general` en `/api/search`

`GET /api/apps` SHALL devolver el mismo payload que `cortex_apps`. `GET /api/search` SHALL aceptar
`include_general` y tratarlo como `false` solo con el valor literal `false`. Razón: el panel y los
scripts leen por REST lo mismo que el agente por MCP.

#### Scenario: GET /api/apps

GIVEN notas con `app: "general"` y `app: "backend"`
WHEN se llama `GET /api/apps`
THEN responde `apps` con ambas y su conteo, y `vocabulary` con `canonicas`, `modo` y `aliases`

#### Scenario: include_general ausente equivale a true

GIVEN una nota con `app: "general"` y otra con `app: "backend"`
WHEN se llama `GET /api/search?q=custodia&app=backend` sin `include_general`
THEN la respuesta puede incluir la nota de `general`
