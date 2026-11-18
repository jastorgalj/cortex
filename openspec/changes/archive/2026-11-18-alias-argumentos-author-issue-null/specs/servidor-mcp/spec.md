## ADDED Requirements

### Requirement: Alias de argumentos sin duplicar el schema

En `tools/call`, el servidor SHALL tratar `query` y `text` como `q` en `cortex_search`, y `body`, `content` y `markdown` como `body_md` en `cortex_write` y `cortex_update`. Los alias SHALL NOT aparecer en el `inputSchema` de `tools/list`, y `q` (en `cortex_search`) y `body_md` (en `cortex_write`) SHALL seguir en su lista `required`. Razón: los agentes leen el schema; un alias declarado lo duplicaría y borraría `required`.

#### Scenario: cortex_search acepta query

GIVEN una nota cuyo cuerpo contiene el identificador `ZX-ALIAS-1`
WHEN se llama `cortex_search` con `{"query": "ZX-ALIAS-1"}` y, aparte, con `{"q": "ZX-ALIAS-1"}`
THEN ambas llamadas responden éxito con la misma lista de ids de notas

#### Scenario: cortex_search acepta text

GIVEN la misma nota
WHEN se llama `cortex_search` con `{"text": "ZX-ALIAS-1"}`
THEN responde éxito y la nota está entre los resultados

#### Scenario: cortex_write acepta content, body y markdown

GIVEN un cliente MCP conectado
WHEN se llama `cortex_write` con `title`, `app`, `kind`, `author` válidos, `force: true`, `reason: "prueba de alias"` y `content: "texto A"`, otra vez con `body: "texto B"` y otra con `markdown: "texto C"` (títulos distintos)
THEN se crean tres notas cuyo `body_md` es `texto A`, `texto B` y `texto C`

#### Scenario: cortex_update acepta body

GIVEN una nota en revisión 1
WHEN se llama `cortex_update` con `id`, `body: "nuevo cuerpo"` y `author` válido
THEN la nota queda con `body_md: "nuevo cuerpo"` y `rev: 2`

#### Scenario: tools/list no muestra alias

GIVEN el servidor levantado
WHEN un cliente MCP envía `tools/list`
THEN ninguna propiedad de ningún `inputSchema` se llama `query`, `text`, `body`, `content` ni `markdown`, `cortex_search` conserva `q` en `required`, y `cortex_write` conserva `body_md` en `required`

### Requirement: Alias con valores distintos se rechazan

Si una misma llamada trae el nombre canónico y un alias, o dos alias, con valores distintos, el servidor SHALL responder un error de la tool (`isError: true`) que nombre la tool y los dos parámetros, sin ejecutar la tool. Con valores idénticos SHALL aceptar la llamada. Razón: elegir uno en silencio guardaría o buscaría algo que el agente no quiso.

#### Scenario: q y query distintos

GIVEN un cliente MCP conectado
WHEN se llama `cortex_search` con `{"q": "uno", "query": "dos"}`
THEN responde `isError: true` con un texto que empieza con `Error en cortex_search` y contiene `q` y `query`

#### Scenario: body_md y content distintos no crean nota

GIVEN un cliente MCP conectado y el conteo de notas de `cortex_list`
WHEN se llama `cortex_write` con `body_md: "A"` y `content: "B"` y el resto válido
THEN responde `isError: true` con un texto que empieza con `Error en cortex_write` y contiene `body_md` y `content`, y el conteo de `cortex_list` no cambia

#### Scenario: Canónico y alias idénticos

GIVEN un cliente MCP conectado
WHEN se llama `cortex_search` con `{"q": "uno", "query": "uno"}`
THEN responde éxito

### Requirement: author opcional con identidad inferida

`cortex_write` y `cortex_update` SHALL aceptar la llamada sin `author` y resolverlo con el primer valor no vacío (tras recortar espacios) de esta lista: el argumento `author`, el header HTTP `x-cortex-author` de esa request, el `name` del `clientInfo` del `initialize` de la sesión, la cadena `agente`. `author` SHALL NOT figurar en `required` de ambas tools. Razón: el agente que olvida `author` pierde el guardado completo por un dato que el servidor puede inferir.

#### Scenario: El argumento gana

GIVEN una request con header `x-cortex-author: ana` y un cliente de nombre `mi-cliente`
WHEN se llama `cortex_write` con `author: "beto"` y el resto válido
THEN la nota queda con `author: "beto"`

#### Scenario: El header gana al cliente

GIVEN una request con header `x-cortex-author: ana` y un cliente de nombre `mi-cliente`
WHEN se llama `cortex_write` sin `author`
THEN la nota queda con `author: "ana"`

#### Scenario: El nombre del cliente gana al valor por defecto

GIVEN una sesión sin header `x-cortex-author` iniciada con `clientInfo.name: "mi-cliente"`
WHEN se llama `cortex_update` con `title: "Título nuevo"` y sin `author` sobre una nota en revisión 1
THEN la nota queda en revisión 2 con `author: "mi-cliente"` y `cortex_history` conserva la revisión 1

#### Scenario: Sin ninguna fuente se usa agente

GIVEN una sesión sin header `x-cortex-author` iniciada con `clientInfo.name` vacío
WHEN se llama `cortex_write` sin `author`
THEN la nota queda con `author: "agente"`

#### Scenario: Un header en blanco se ignora

GIVEN una request con header `x-cortex-author` de solo espacios y un cliente de nombre `mi-cliente`
WHEN se llama `cortex_write` sin `author`
THEN la nota queda con `author: "mi-cliente"`

#### Scenario: tools/list declara author opcional

GIVEN el servidor levantado
WHEN un cliente MCP envía `tools/list`
THEN `author` está declarado en `cortex_write` y `cortex_update` y no figura en su lista `required`

### Requirement: Un author enviado vacío sigue rechazado

`cortex_write` y `cortex_update` SHALL rechazar un `author` presente pero vacío o de solo espacios, sin crear ni modificar nada y sin recurrir a las demás fuentes. Razón: omitirlo es olvido y se infiere; enviarlo vacío es un valor inválido explícito (escenario vigente «Escritura sin autor rechazada»).

#### Scenario: author vacío con header presente

GIVEN una request con header `x-cortex-author: ana`
WHEN se llama `cortex_write` con `author: ""` y el resto válido
THEN responde `isError: true` con un texto que contiene `author` y no se crea ninguna nota

### Requirement: cortex_delete exige author

`cortex_delete` SHALL seguir exigiendo `author` explícito y no vacío: SHALL NOT usar el header `x-cortex-author`, el `clientInfo` ni `agente` como valor por defecto, y `author` SHALL figurar en su lista `required`. Razón: el borrado es la única operación que las tools no deshacen y el historial registra quién borró.

#### Scenario: Borrado sin author

GIVEN una nota existente y una request con header `x-cortex-author: ana`
WHEN se llama `cortex_delete` con `id` y `reason` pero sin `author`
THEN responde `isError: true`, la nota sigue visible en `cortex_list` y su historial no cambia

#### Scenario: tools/list mantiene author requerido en cortex_delete

GIVEN el servidor levantado
WHEN un cliente MCP envía `tools/list`
THEN `cortex_delete` lista `author` en `required`

### Requirement: El schema de cortex_write declara issue como texto o null

`cortex_write` SHALL declarar `issue` en su schema como texto o `null`, opcional. Razón: un agente que quiere decir «sin issue» envía `null`; un schema que lo rechaza le cuesta un turno.

#### Scenario: tools/list muestra issue nullable en cortex_write

GIVEN el servidor levantado
WHEN un cliente MCP envía `tools/list`
THEN `cortex_write` declara `issue` con tipo que admite `string` y `null`, y no figura en `required`
