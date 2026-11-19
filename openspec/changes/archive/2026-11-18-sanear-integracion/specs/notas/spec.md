## ADDED Requirements

### Requirement: El modo estricto de bitácoras no se salta con force

Con `CORTEX_STRICT_NOTES` activo, `cortex_write` SHALL rechazar una nota con aspecto de bitácora aunque traiga `force: true` y `reason`; `force` solo anula la detección de duplicados. Razón: `force` lleva un texto libre del propio agente; si bastara para saltar la política, el modo estricto sería decorativo.

#### Scenario: Bitácora con force en modo estricto

GIVEN `CORTEX_STRICT_NOTES` activo
WHEN se llama `cortex_write` con título `Cierre SEC-2: MR !44 mergeado`, `force: true` y `reason: "es un cierre legítimo"`
THEN responde `isError: true` sobre el campo `title` y no se crea ninguna nota

### Requirement: El rechazo estricto explica que force no lo evita

El mensaje de rechazo por bitácora SHALL decir que `force` no lo evita, y la descripción de `cortex_write` SHALL nombrar `CORTEX_STRICT_NOTES` y declarar que `force` no lo anula. Razón: la descripción vigente manda a usar `force: true` «para crear igualmente», y el agente que la sigue gasta un turno en un reintento que falla igual.

#### Scenario: El mensaje dice que force no lo evita

GIVEN `CORTEX_STRICT_NOTES` activo
WHEN se llama `cortex_write` con título `Cierre SEC-2: MR !44 mergeado`
THEN el texto de error contiene `force` y dice que no evita el rechazo

#### Scenario: La descripción de cortex_write declara el modo estricto

GIVEN el servidor levantado
WHEN un cliente MCP envía `tools/list`
THEN la descripción de `cortex_write` nombra `CORTEX_STRICT_NOTES` y dice que `force` no lo anula

### Requirement: El modo strict de apps no se salta con force

Con `CORTEX_APPS` declarado y `CORTEX_APP_MODE=strict`, `cortex_write` SHALL rechazar un `app` fuera del vocabulario aunque traiga `force: true` y `reason`. Razón: es una validación de datos, no de duplicados; `force` no la cubre.

#### Scenario: App desconocida con force en modo strict de apps

GIVEN `CORTEX_APPS: "backend,console,general"` y `CORTEX_APP_MODE: "strict"`
WHEN se llama `cortex_write` con `app: "sistema-nuevo"`, `force: true` y `reason` no vacío
THEN responde `isError: true` sobre el campo `app` y no se crea ninguna nota

### Requirement: El importador queda sujeto a los modos estrictos

El comando de importación SHALL aplicar `CORTEX_STRICT_NOTES` y `CORTEX_APP_MODE=strict` como cualquier escritura: un archivo rechazado SHALL contarse como error con el mensaje de rechazo, y los demás SHALL importarse. Razón: el importador escribe con `force: true` por diseño y `force` no anula los modos estrictos.

#### Scenario: Learning con título de bitácora en modo estricto

GIVEN `CORTEX_STRICT_NOTES` activo y un repo con un learning de título `2026-11-10 rotación de claves` y otro de título normal
WHEN corre el comando de importación
THEN el reporte cuenta 1 creada y 1 error con el mensaje de rechazo, y el proceso termina con código 1
