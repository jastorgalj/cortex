## ADDED Requirements

### Requirement: `cortex_list` pagina y reporta el total

`cortex_list` SHALL aceptar `limit` (entero, default 50, máximo 200) y `offset` (entero, mínimo 0) y
SHALL responder `{ total, items, next_offset }`: `total` es la cantidad de notas que cumplen el
filtro. La base SHALL recibir solo la página pedida (`take`/`skip`) y los ítems SHALL NOT incluir
`body_md`. Razón: las respuestas van al contexto del agente y sin tope crecen con el corpus.

#### Scenario: Sin argumentos devuelve la primera página

GIVEN un corpus con más de 50 notas no borradas
WHEN un cliente MCP llama `cortex_list` sin argumentos
THEN `items` trae 50 notas, `total` es el número de notas del corpus y `next_offset` es 50

#### Scenario: Última página

GIVEN un corpus con 51 notas y `offset: 50`
WHEN se llama `cortex_list` con `limit: 50` y `offset: 50`
THEN `items` trae 1 nota y `next_offset` es `null`

#### Scenario: Las páginas no se solapan

GIVEN dos llamadas consecutivas con `offset: 0` y `offset: 2`, ambas con `limit: 2`
WHEN se comparan los ids devueltos
THEN ningún id de la segunda página aparece en la primera

### Requirement: `cortex_history` devuelve metadatos por defecto

`cortex_history` SHALL aceptar `rev` (entero), `include_body` (booleano) y `limit` (entero, default 10,
máximo 50), y SHALL responder `{ total, items }`. Sin `include_body` los ítems SHALL omitir
`body_md`; con `rev: N` la respuesta SHALL traer solo esa revisión, con su cuerpo. Razón: el historial
repetía el cuerpo entero N veces en el contexto del agente; el cuerpo se pide cuando hace falta.

#### Scenario: Sin argumentos no viaja ningún cuerpo

GIVEN una nota con dos revisiones
WHEN un cliente MCP llama `cortex_history` con solo el `id`
THEN `total` es 2, `items` trae las revisiones 1 y 2 en orden ascendente y ningún ítem tiene `body_md`

#### Scenario: Una revisión puntual trae su cuerpo

GIVEN la misma nota
WHEN se llama `cortex_history` con `rev: 1`
THEN `items` tiene un solo elemento, `rev` 1, con su `body_md`

#### Scenario: El tope se queda con lo más reciente

GIVEN una nota con dos revisiones y `limit: 1`
WHEN se llama `cortex_history` con ese `limit`
THEN `total` es 2 e `items` trae solo la revisión 2

### Requirement: Las respuestas MCP son JSON compacto

Toda respuesta exitosa de las tools MCP SHALL serializarse con `JSON.stringify(valor)`, sin
indentación ni saltos de línea. Razón: la indentación no aporta información al agente y multiplica los
tokens de cada llamada.

#### Scenario: Respuesta sin indentación

GIVEN un cliente MCP conectado
WHEN llama `cortex_list`, `cortex_read`, `cortex_history` y `cortex_search`
THEN el texto de cada respuesta se parsea como JSON y no contiene saltos de línea
