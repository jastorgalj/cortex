## ADDED Requirements

### Requirement: La creación normaliza issue null o vacío

`cortex_write` SHALL aceptar `issue` omitido, `null`, vacío o de solo espacios y guardar `issue` como `NULL` en los cuatro casos; un `issue` con texto SHALL guardarse como llegó. La detección de duplicados SHALL tratar esos cuatro casos como «sin issue». Razón: «sin issue» tiene una sola representación (`NULL`); guardar `""` dejaría dos.

#### Scenario: issue null en la creación

GIVEN un cliente MCP conectado
WHEN se llama `cortex_write` con `issue: null` y el resto válido
THEN la nota se crea con `issue: null`

#### Scenario: issue vacío o en blanco en la creación

GIVEN un cliente MCP conectado
WHEN se llama `cortex_write` con `issue: ""` y otra con `issue: "   "` (títulos y contenidos distintos, ambas con `force: true` y `reason: "prueba de issue vacío"`)
THEN la respuesta de cada llamada y el `cortex_read` de cada id muestran `issue: null`

#### Scenario: issue con texto no cambia

GIVEN un cliente MCP conectado
WHEN se llama `cortex_write` con `issue: "ABC-1"`
THEN la nota queda con `issue: "ABC-1"` y `cortex_list` con `issue: "abc-1"` la incluye

#### Scenario: issue null no rompe el aviso de duplicado

GIVEN una nota existente sin issue
WHEN se llama `cortex_write` con `issue: null` y el mismo título y cuerpo, sin `force`
THEN responde `status: "similar_exists"` con esa nota entre las candidatas
