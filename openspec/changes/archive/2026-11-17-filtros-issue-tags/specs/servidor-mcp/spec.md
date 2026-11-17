## MODIFIED Requirements

### Requirement: API REST de solo lectura

El proceso SHALL exponer `GET /api/search` (parámetros q, app, kind, issue, tags, limit) y
`GET /api/notes/:id` respondiendo JSON con los mismos resultados que `cortex_search` y
`cortex_read`. Ningún método de escritura SHALL existir bajo `/api`. Razón: scripts, CI y
debugging necesitan acceso sin cliente MCP; la escritura queda concentrada en `/mcp`, donde
viven la validación, las revisiones y la deduplicación.

#### Scenario: Búsqueda por curl coincide con la tool

GIVEN un corpus con notas
WHEN se consulta `GET /api/search?q=<términos>` y `cortex_search` con los mismos términos
THEN ambos devuelven los mismos ids en el mismo orden

#### Scenario: Escritura por REST inexistente

GIVEN el servidor levantado
WHEN se envía POST/PUT/PATCH/DELETE a cualquier ruta bajo `/api`
THEN responde 404 o 405 y ninguna nota cambia

## ADDED Requirements

### Requirement: Filtros de la búsqueda REST por query string

`GET /api/search` SHALL recibir `issue` como texto y `tags` como lista separada por comas (`tags=a,b`),
recortando los espacios de cada elemento y descartando los vacíos, y SHALL aplicar la misma semántica de
filtro que `cortex_search`. Un tag que contenga una coma no es filtrable por esta ruta. Razón: el query
string no tiene arreglos; sin esta regla cada cliente inventaría su formato.

#### Scenario: Filtrar por tags desde curl

GIVEN notas con tags `["area:x"]` y notas sin ese tag, todas encontrables con `q=tasa`
WHEN se consulta `GET /api/search?q=tasa&tags=area:x`
THEN el JSON contiene solo notas con el tag `area:x`, los mismos ids y orden que `cortex_search` con
`tags: ["area:x"]`

#### Scenario: Varios tags se combinan con AND

GIVEN una nota con tags `["area:x", "repo:y"]` y otra con `["area:x"]`
WHEN se consulta `GET /api/search?q=tasa&tags=area:x,repo:y`
THEN el JSON contiene la primera nota y no la segunda

#### Scenario: Filtrar por issue desde curl

GIVEN una nota con `issue: "ABC-1"` y otra con `issue: "ABC-2"`, ambas encontrables con `q=tasa`
WHEN se consulta `GET /api/search?q=tasa&issue=abc-1`
THEN el JSON contiene la nota de `ABC-1`, no la de `ABC-2`, y cada resultado trae el campo `issue`

#### Scenario: Elementos vacíos en tags se descartan

GIVEN las mismas notas
WHEN se consulta `GET /api/search?q=tasa&tags=,area:x,`
THEN el resultado es el mismo que con `tags=area:x`

### Requirement: El schema de las tools declara issue y tags

`cortex_search` SHALL declarar en su schema los parámetros `issue` (texto) y `tags` (lista de textos);
`cortex_list` SHALL declarar `issue`; `cortex_update` SHALL declarar `issue` como texto o `null`. Razón: un
parámetro que el schema no declara se descarta en silencio y el agente cree que filtró cuando no lo hizo.

#### Scenario: tools/list muestra los parámetros nuevos

GIVEN el servidor levantado
WHEN un cliente MCP envía `tools/list`
THEN `cortex_search` declara `issue` y `tags` (array de strings), `cortex_list` declara `issue`, y
`cortex_update` declara `issue` con tipo que admite `string` y `null`

#### Scenario: cortex_update acepta null en issue por MCP

GIVEN una nota con `issue: "ABC-1"` y un cliente MCP conectado
WHEN el cliente llama `cortex_update` con `issue: null`
THEN la llamada responde éxito y la nota queda con `issue: null`
