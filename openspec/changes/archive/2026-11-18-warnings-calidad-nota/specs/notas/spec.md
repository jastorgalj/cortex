## ADDED Requirements

### Requirement: La escritura avisa cuando el contenido no calza con su tipo

`cortex_write` y `cortex_update` SHALL responder con un campo opcional `warnings` (lista de textos) cuando
el contenido parece bitácora o no tiene la forma que su `kind` promete; la escritura SHALL completarse
igual —el aviso no bloquea— y una nota bien formada SHALL responder sin el campo. Con
`CORTEX_STRICT_NOTES` activo, la creación de una bitácora SHALL rechazarse con `ValidationError`.

#### Scenario: Bitácora creada con aviso

GIVEN una nota nueva con título `Cierre ABC-1: MR !93 mergeado`
WHEN se llama `cortex_write` en el modo por defecto
THEN la nota se crea y la respuesta incluye `warnings` con un texto que dice que parece bitácora y que
Cortex guarda conocimiento reutilizable

#### Scenario: Nota bien formada sin warnings

GIVEN una nota nueva sobre cómo funciona un módulo, sin marcas de bitácora y con el contenido que su
`kind` describe
WHEN se llama `cortex_write`
THEN la nota se crea y la respuesta no incluye `warnings`

#### Scenario: pitfall sin causa advierte con el esqueleto esperado

GIVEN una nota con `kind: "pitfall"` cuyo cuerpo no nombra causa ni arreglo
WHEN se llama `cortex_write`
THEN la respuesta incluye `warnings` con el esqueleto esperado del tipo (síntoma, causa, arreglo) tomado
de la descripción del `kind`

#### Scenario: Modo estricto rechaza la bitácora

GIVEN `CORTEX_STRICT_NOTES` activo
WHEN se llama `cortex_write` con título de bitácora y el resto de los campos válidos
THEN responde `ValidationError` nombrando el campo donde se detectó el patrón y no crea ninguna nota
