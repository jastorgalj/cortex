## MODIFIED Requirements

### Requirement: Las tools declaran su schema y responden errores descriptivos

Cada tool SHALL declarar su schema de parámetros y responder errores descriptivos (qué parámetro
falta o qué id no existe) que nombren la tool con su nombre vigente, nunca errores opacos. El campo
`kind` SHALL describir en su schema el significado de cada tipo válido, para que el agente elija el
tipo correcto sin leer una nota. Razón: los consumidores son agentes — un error que no dice qué
corregir produce reintentos a ciegas, y un `kind` sin significado produce clasificación a ciegas.

#### Scenario: Los mensajes de error usan los nombres nuevos

GIVEN el servidor levantado
WHEN se llama `cortex_read` con un id inexistente
THEN el mensaje de error empieza con `Error en cortex_read` y no contiene la cadena `kb_`

#### Scenario: El campo kind describe cada tipo

GIVEN el servidor levantado
WHEN un cliente MCP inspecciona el schema del campo `kind` de `cortex_write`
THEN su descripción nombra los cinco tipos válidos y explica el significado de cada uno, sin mencionar `otro`
