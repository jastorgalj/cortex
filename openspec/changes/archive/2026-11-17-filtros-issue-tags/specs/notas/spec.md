## ADDED Requirements

### Requirement: La actualización puede corregir o quitar el issue

`cortex_update` SHALL aceptar `issue` opcional: un texto lo reemplaza (guardado sin espacios en los
extremos), `null` lo quita, y omitirlo lo deja como está. La actualización SHALL seguir el mismo camino
que las demás: inserta la revisión de la versión vigente y avanza `rev` en uno. Razón: un `issue` mal
escrito no debería obligar a borrar y reescribir, lo que pierde el historial y cambia el id.

#### Scenario: Corregir el issue

GIVEN una nota en revisión 1 con `issue: "ABC-1"`
WHEN se llama `cortex_update` con `issue: "ABC-2"` y `author` válido
THEN la nota queda con `issue: "ABC-2"` y `rev: 2`, `cortex_history` conserva la revisión 1, y
`cortex_list` con `issue: "ABC-2"` la incluye y con `issue: "ABC-1"` no

#### Scenario: Quitar el issue con null

GIVEN una nota con `issue: "ABC-1"`
WHEN se llama `cortex_update` con `issue: null` y `author` válido
THEN la nota queda con `issue: null` y ya no aparece en `cortex_list` con `issue: "ABC-1"`

#### Scenario: Omitir issue no lo cambia

GIVEN una nota con `issue: "ABC-1"`
WHEN se llama `cortex_update` con solo `title` nuevo y `author` válido
THEN la nota conserva `issue: "ABC-1"`

### Requirement: El issue vacío se rechaza en la actualización

`cortex_update` SHALL rechazar un `issue` vacío o de solo espacios con `ValidationError` sobre el campo
`issue`, indicando que se use `null` para quitarlo, sin modificar la nota ni crear revisión. Razón: «sin
issue» tiene una sola representación (`null`); aceptar `""` dejaría dos.

#### Scenario: issue vacío rechazado

GIVEN una nota con `issue: "ABC-1"` en revisión 1
WHEN se llama `cortex_update` con `issue: ""`, o con `issue: "   "`
THEN responde error que nombra `issue` e indica usar `null` para quitarlo, la nota conserva
`issue: "ABC-1"` y `rev: 1`, y `cortex_history` no gana revisiones
