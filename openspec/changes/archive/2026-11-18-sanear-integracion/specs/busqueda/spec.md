## MODIFIED Requirements

### Requirement: Filtros por app, kind y tags

`cortex_search` y `cortex_list` SHALL aceptar filtros opcionales por `app`, `kind` y `tags`, que restringen los resultados a notas que cumplan todos los filtros pedidos; el filtro por `app` incluye además las notas de `general` salvo `include_general: false` (requirement «Los listados por `app` incluyen `general`»). `tags` SHALL ser una lista y la nota SHALL tener todos los tags pedidos (AND), cada uno por igualdad exacta; una lista vacía no filtra. Razón: el corpus mezcla sistemas distintos y el filtro evita el ruido cross-dominio; `kind` permite rescates deterministas como «todas las reglas de cartera».

#### Scenario: El filtro excluye otros dominios

GIVEN notas con `app: cartera` y notas con `app: huella` que comparten vocabulario
WHEN se busca con filtro `app: "cartera"`
THEN ningún resultado tiene `app: huella`

#### Scenario: Listado de reglas de una app

GIVEN notas de cartera con kinds variados, de las que 3 son `regla`, y ninguna nota con `app: general`
WHEN se llama `cortex_list` con `app: "cartera"` y `kind: "regla"`
THEN `items` contiene esas 3 notas y ninguna otra, y `total` es 3

#### Scenario: La búsqueda por tags exige todos los tags

GIVEN una nota A con tags `["area:x", "repo:y"]`, una nota B con tags `["area:x"]` y una nota C sin tags,
las tres encontrables con la misma búsqueda
WHEN se ejecuta `cortex_search` con `tags: ["area:x", "repo:y"]`
THEN el resultado contiene la nota A y no contiene B ni C

#### Scenario: Un solo tag basta para restringir

GIVEN las mismas notas A, B y C
WHEN se ejecuta `cortex_search` con `tags: ["area:x"]`
THEN el resultado contiene A y B y no contiene C

#### Scenario: Una lista de tags vacía no filtra

GIVEN las mismas notas A, B y C
WHEN se ejecuta `cortex_search` con `tags: []`
THEN el resultado contiene las tres notas, igual que sin el parámetro

## ADDED Requirements

### Requirement: Una app en blanco no filtra

Un filtro `app` vacío o de solo espacios SHALL tratarse como ausente en `cortex_list`, `cortex_search` y `GET /api/search`, igual que `issue`, `kind` y `author` vacíos. Razón: hoy `app: "   "` se normaliza a la cadena vacía y el filtro devuelve solo las notas de `general` (medido: 1 de 15 notas), lo que parece un listado completo y no lo es.

#### Scenario: app en blanco en el listado

GIVEN 15 notas no borradas de apps distintas
WHEN se llama `cortex_list` con `app: "   "` y `limit: 200`
THEN `total` es 15, igual que sin el parámetro

#### Scenario: app en blanco en la búsqueda

GIVEN notas de `backend` y de `general` encontrables con la misma búsqueda
WHEN se ejecuta `cortex_search` con `app: "   "`
THEN el resultado incluye notas de `backend`, igual que sin el parámetro
