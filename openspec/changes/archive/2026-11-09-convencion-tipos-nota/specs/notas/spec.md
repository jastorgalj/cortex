## MODIFIED Requirements

### Requirement: Una nota tiene autoría declarada y clasificación estructurada

Toda nota SHALL tener título, cuerpo markdown, autor no vacío, `app` no vacío, `kind` dentro
del enum cerrado de cinco tipos —`sistema`, `flujo`, `decision`, `pitfall`, `regla`—, tags
libres y fechas; `issue` es opcional. Una escritura con `author`, `app` o `kind` inválidos SHALL
ser rechazada indicando el campo. Razón: la clasificación libre degenera y el agente pierde el
rescate determinista (fricción medida del repo git anterior).

#### Scenario: Escritura sin autor rechazada

GIVEN una llamada `cortex_write` con título y cuerpo válidos y `author` vacío
WHEN el servidor la procesa
THEN responde error nombrando `author` como campo requerido y no crea ninguna nota

#### Scenario: kind fuera del enum rechazado

GIVEN una llamada `cortex_write` con `kind: "nota-rapida"` o `kind: "otro"`
WHEN el servidor la procesa
THEN responde error nombrando los valores válidos del enum y no crea ninguna nota

#### Scenario: kind 'otro' rechazado

GIVEN una llamada `cortex_write` con `kind: "otro"` y el resto de los campos válidos
WHEN el servidor la procesa
THEN responde error nombrando los cinco valores válidos (sin `otro`) y no crea ninguna nota

## ADDED Requirements

### Requirement: La actualización puede corregir la clasificación

`cortex_update` SHALL aceptar `app` y `kind` opcionales para corregir la clasificación de una nota
existente sin borrarla ni perder su historial de revisiones; `kind` SHALL validarse contra el enum
cerrado de cinco tipos y `app` SHALL ser no vacío, rechazando con `ValidationError` el campo inválido.
Razón: una nota con `kind` o `app` equivocados no debería obligar a borrar y reescribir, lo que pierde
el historial y cambia el id.

#### Scenario: Corregir el kind conserva el historial

GIVEN una nota existente en revisión 1 con `kind: "pitfall"`
WHEN se llama `cortex_update` con `kind: "regla"` y `author` válido
THEN la nota queda con `kind: "regla"` y revisión 2, y `cortex_history` conserva la revisión 1

#### Scenario: kind inválido en la actualización rechazado

GIVEN una nota existente
WHEN se llama `cortex_update` con `kind: "otro"`
THEN responde error nombrando los valores válidos y la nota no cambia
