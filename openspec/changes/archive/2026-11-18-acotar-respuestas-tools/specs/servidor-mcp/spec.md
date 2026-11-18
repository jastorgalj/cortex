## ADDED Requirements

### Requirement: Las respuestas JSON de las tools son compactas

Toda respuesta exitosa de las siete tools que lleve JSON, incluida la de `similar_exists` de `cortex_write`,
SHALL serializarse sin indentación ni saltos de línea entre elementos, de modo que su texto sea igual a
`JSON.stringify(JSON.parse(texto))`. Razón: la indentación suma 23 % de caracteres (medido en
`cortex_list`: 33.916 contra 26.112) sin dar nada al agente.

#### Scenario: Ninguna tool indenta

GIVEN el servidor levantado y notas existentes, entre ellas dos casi idénticas
WHEN se ejecutan con éxito `cortex_search`, `cortex_read`, `cortex_write` (nota nueva), `cortex_write` que
responde `similar_exists`, `cortex_update`, `cortex_list`, `cortex_history` y `cortex_delete`
THEN el texto de cada respuesta es igual a `JSON.stringify(JSON.parse(texto))`

### Requirement: Las respuestas de list e history tienen un tope de 20.000 caracteres

Si el texto de la respuesta de `cortex_list` o de `cortex_history` supera 20.000 caracteres (su `length`),
el servidor SHALL quitar ítems enteros hasta que quepa, dejando siempre al menos uno, y SHALL agregar
`"truncated": true`; si no quitó ningún ítem, la respuesta SHALL no traer la clave `truncated`.
`cortex_read` y `cortex_history` con `rev` SHALL quedar fuera del tope. Razón: cortar el texto a la
mitad deja JSON inválido, y una lectura puntual existe para traer el cuerpo completo.

#### Scenario: Una lista que no cabe se recorta por ítems

GIVEN 30 notas no borradas con título de 1.000 caracteres cada una
WHEN se llama `cortex_list` con `limit: 30`
THEN el texto tiene 20.000 caracteres o menos y es JSON válido, `truncated` es `true`, `items` tiene entre 1
y 29 notas completas, y `total` es 30

#### Scenario: Sin recorte no hay truncated

GIVEN 3 notas no borradas
WHEN se llama `cortex_list`
THEN la respuesta no tiene la clave `truncated`

#### Scenario: Un ítem que solo supera el tope se devuelve igual

GIVEN una nota con una revisión guardada cuyo cuerpo tiene 25.000 caracteres
WHEN se llama `cortex_history` con `include_body: true` y `limit: 1`
THEN `items` tiene esa revisión, el texto supera 20.000 caracteres y la respuesta no tiene la clave
`truncated`

#### Scenario: Las lecturas puntuales no se recortan

GIVEN una nota creada con un cuerpo de 25.000 caracteres y actualizada con un cuerpo de 25.100 caracteres
(el anterior más 100)
WHEN se llama `cortex_read` con su id y `cortex_history` con `rev: 1`
THEN `cortex_read` trae un `body_md` de 25.100 caracteres y `cortex_history` trae el `body_md` de 25.000
de la revisión 1, ambos completos

### Requirement: El recorte de cortex_list se continúa con next_offset

Cuando `cortex_list` quita ítems por el tope, SHALL quitarlos del final y `next_offset` SHALL valer
`offset` más los ítems conservados, o `null` si no queda ninguno por mostrar. Razón: seguir `next_offset`
debe recorrer todas las notas sin perder las que el tope dejó fuera.

#### Scenario: Seguir next_offset no pierde notas

GIVEN las 30 notas de título de 1.000 caracteres
WHEN se llama `cortex_list` con `limit: 30` y se repite con el `next_offset` devuelto hasta que sea `null`
THEN la unión de los `items` de todas las respuestas son los 30 ids, cada uno una vez

### Requirement: El recorte de cortex_history conserva las revisiones recientes

Cuando `cortex_history` quita ítems por el tope, SHALL quitar los de menor `rev` y conservar los de mayor
`rev`, en orden ascendente; `total` SHALL seguir contando todas las revisiones guardadas. Razón: la
revisión más reciente es la que casi siempre se necesita; las anteriores se piden con `rev`.

#### Scenario: Se quedan las más recientes

GIVEN una nota con 5 revisiones guardadas de 6.000 caracteres de cuerpo cada una
WHEN se llama `cortex_history` con `include_body: true`
THEN `truncated` es `true`, `total` es 5, `items` tiene entre 1 y 4 revisiones que terminan en `rev: 5` y
son consecutivas, y el texto tiene 20.000 caracteres o menos

### Requirement: El schema declara los parámetros de paginación

`cortex_list` SHALL declarar en su schema `limit` y `offset` (enteros) y `cortex_history` SHALL declarar
`limit` (entero), `include_body` (booleano) y `rev` (entero), cada uno con una descripción que nombra su
defecto y su rango. La descripción de `cortex_history` SHALL no afirmar que devuelve el historial
completo ni todas las versiones. Razón: un parámetro que el schema no declara se descarta en silencio y
el agente cree haber paginado.

#### Scenario: tools/list muestra los parámetros nuevos

GIVEN el servidor levantado
WHEN un cliente MCP envía `tools/list`
THEN `cortex_list` declara `limit` y `offset` con tipo `integer`, `cortex_history` declara `limit` e `rev`
con tipo `integer` e `include_body` con tipo `boolean`, y la descripción de `cortex_history` no contiene la
cadena `completo`
