## ADDED Requirements

### Requirement: La escritura normaliza `app` y valida el vocabulario configurado

`cortex_write` y `cortex_update` SHALL normalizar `app` (trim y minúsculas), resolver alias y persistir el
valor canónico. Con `CORTEX_APPS`, un valor fuera del vocabulario SHALL aceptarse con `warnings` en modo
`warn` (default) y rechazarse con `ValidationError` que liste los válidos en modo `strict`. Sin
`CORTEX_APPS` SHALL aceptarse cualquier valor no vacío, y `general` SHALL ser siempre válido. Razón: lo
persistido tiene que ser lo que se filtra, sin migrar datos.

#### Scenario: un alias se persiste como su valor canónico

GIVEN `CORTEX_APPS: "backend,general"` y `CORTEX_APP_ALIASES: {"back":"backend"}`
WHEN se llama `cortex_write` con `app: "Back"`
THEN la nota queda con `app: "backend"` y la respuesta no trae `warnings`

#### Scenario: un valor desconocido en modo warn se acepta con aviso

GIVEN `CORTEX_APPS: "backend,general"` y `CORTEX_APP_MODE: "warn"`
WHEN se llama `cortex_write` con `app: "inventada"`
THEN la nota se crea con `app: "inventada"` y la respuesta trae un `warnings` que nombra los valores válidos

#### Scenario: un valor desconocido en modo strict se rechaza

GIVEN `CORTEX_APPS: "backend,general"` y `CORTEX_APP_MODE: "strict"`
WHEN se llama `cortex_write` con `app: "inventada"`
THEN responde error de parámetro inválido `app` y la nota no se crea

#### Scenario: sin vocabulario se acepta cualquier app normalizada

GIVEN un servidor sin `CORTEX_APPS`
WHEN se llama `cortex_write` con `app: "  Backend "`
THEN la nota queda con `app: "backend"`

#### Scenario: `general` es válido con vocabulario en modo strict

GIVEN `CORTEX_APPS: "backend"` y `CORTEX_APP_MODE: "strict"`
WHEN se llama `cortex_write` con `app: "general"`
THEN la nota se crea con `app: "general"`

### Requirement: Los listados por `app` incluyen `general`

`cortex_list` con `app` SHALL devolver las notas de esa app y las de `general`, salvo con
`include_general: false`, que SHALL devolver solo la app pedida. El filtro SHALL normalizar y resolver
alias sin rechazar valores, y cada nota del listado SHALL mostrar su `app`. Razón: las reglas y
convenciones transversales viven en `general`; excluirlas hace creer que no existen.

#### Scenario: una regla de `general` aparece al filtrar por otra app

GIVEN una nota con `app: "general"` y `kind: "regla"` y otra con `app: "backend"` y `kind: "regla"`
WHEN se llama `cortex_list` con `app: "backend"` y `kind: "regla"`
THEN el resultado incluye las dos notas, cada una con su `app`

#### Scenario: include_general false devuelve solo la app pedida

GIVEN las mismas dos notas
WHEN se llama `cortex_list` con `app: "backend"`, `kind: "regla"` e `include_general: false`
THEN el resultado trae solo la nota con `app: "backend"`

#### Scenario: el filtro acepta mayúsculas y alias

GIVEN una nota con `app: "backend"`
WHEN se llama `cortex_list` con `app: "BACK"` y `CORTEX_APP_ALIASES` mapea `back` a `backend`
THEN el resultado la incluye
