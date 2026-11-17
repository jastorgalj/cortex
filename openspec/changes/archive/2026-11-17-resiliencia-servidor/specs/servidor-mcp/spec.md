## MODIFIED Requirements

### Requirement: Healthcheck

`GET /health` SHALL responder 200 con `{status: "ok", notes, model_loaded, sessions, uptime_s}` cuando la DB responde, y 503 con `{status: "degraded", db: "down", model_loaded, sessions, uptime_s, error}` cuando la DB falla o no responde en 3 s. El campo `error` SHALL ser un texto fijo, no el mensaje de Prisma. Razón: es la señal del healthcheck de Docker y el diagnóstico más barato; un 500 genérico no distingue «BD caída» de «bug», y el mensaje de Prisma trae host y puerto de la base.

#### Scenario: Health con el servicio sano

GIVEN el servidor levantado con la DB inicializada
WHEN se consulta `GET /health`
THEN responde 200 con `status: "ok"`, el conteo de notas, el estado del modelo, `sessions` (entero ≥ 0) y `uptime_s` (entero ≥ 0)

#### Scenario: Health con la BD caída

GIVEN el servidor levantado y la DB pausada o detenida
WHEN se consulta `GET /health`
THEN responde 503 en menos de 5 s con `status: "degraded"` y `db: "down"`, y el cuerpo no contiene el host ni el puerto de la base

#### Scenario: Health se recupera sin reiniciar

GIVEN el servidor levantado, la DB caída y `GET /health` respondiendo 503
WHEN la DB vuelve a estar disponible
THEN el siguiente `GET /health` dentro de los 40 s siguientes responde 200, sin reiniciar el proceso

## ADDED Requirements

### Requirement: El sondeo de salud no acumula consultas colgadas

`GET /health` SHALL mantener como máximo un sondeo a la DB en curso: las requests que llegan mientras otro sondeo sigue pendiente comparten su resultado. Un sondeo con más de 30 s sin terminar SHALL darse por perdido y permitir uno nuevo. Razón: con la DB pausada la consulta no falla, queda colgada; un sondeo nuevo por request agotaría el pool de conexiones y las tools fallarían con pool agotado aun después de volver la DB.

#### Scenario: Requests simultáneas con la DB colgada

GIVEN un cliente de BD de prueba cuya consulta no termina
WHEN llegan 20 requests simultáneas a `GET /health`
THEN el cliente de BD recibe exactamente 1 consulta y las 20 responden 503

#### Scenario: Sondeo perdido tras 30 s

GIVEN un sondeo pendiente desde hace más de 30 s
WHEN llega una request a `GET /health`
THEN se inicia un sondeo nuevo

### Requirement: Reintento ante fallos de conexión con la BD

El acceso a la DB de las tools MCP SHALL reintentar hasta 3 veces, con esperas de 200, 500 y 1000 ms, cuando la consulta no llegó a ejecutarse: `PrismaClientInitializationError` o código Prisma P1001, P1002 o P2024. No SHALL iniciarse un intento nuevo si pasaron más de 8 s desde el primero. Razón: un corte breve o un pool ocupado no debe llegar al agente como error.

#### Scenario: Lectura que se recupera

GIVEN una lectura cuyo primer intento falla con P1001 y el segundo tiene éxito
WHEN se ejecuta `cortex_read`
THEN la tool responde la nota sin error y la consulta se intentó 2 veces

#### Scenario: Error de negocio sin reintento

GIVEN una operación que falla con `NotFoundError`, `ValidationError`, `ConflictError` o código Prisma P2002
WHEN se ejecuta la tool
THEN se intenta 1 sola vez y el error llega a la tool sin cambios

#### Scenario: Reintentos agotados

GIVEN una lectura cuyos 4 intentos fallan con P1001
WHEN se ejecuta `cortex_search`
THEN se intentó 4 veces, no más, y la tool responde `isError: true`

### Requirement: Las escrituras solo reintentan si no pudieron aplicarse

El error P1017 (el servidor cerró la conexión) SHALL reintentarse solo en lecturas. Las escrituras —`$transaction`, `create`, `update`, `delete`, `$executeRaw` y cualquier operación no reconocida como lectura— SHALL no reintentarse ante P1017. Razón: con P1017 la transacción pudo haberse confirmado; reintentar duplicaría la nota (`cortex_write`) o avanzaría dos veces la revisión (`cortex_update` sin `base_rev`).

#### Scenario: Lectura con P1017

GIVEN una lectura cuyo primer intento falla con P1017 y el segundo tiene éxito
WHEN se ejecuta `cortex_list`
THEN la tool responde éxito y la consulta se intentó 2 veces

#### Scenario: Escritura con P1017

GIVEN una escritura que falla con P1017
WHEN se ejecuta `cortex_write`
THEN se intentó 1 sola vez y la tool responde `isError: true`

#### Scenario: Escritura que nunca llegó a la BD

GIVEN una escritura cuyo primer intento falla con `PrismaClientInitializationError` y el segundo tiene éxito
WHEN se ejecuta `cortex_write`
THEN la nota se crea una sola vez

### Requirement: Mensaje al agente cuando la BD no está disponible

Cuando los reintentos se agotan, la tool SHALL responder `isError: true` con un texto que empiece por `Error en cortex_<tool>:` y diga `Base de datos no disponible; reintentá en unos segundos`. El texto no SHALL contener host, puerto ni stack de Prisma. Razón: el agente actúa sobre el mensaje; el stack de Prisma no le dice qué hacer y expone la dirección de la base.

#### Scenario: Mensaje tras agotar reintentos

GIVEN una lectura cuyos 4 intentos fallan con P1001 contra el host `db.ejemplo.interno:5432`
WHEN se ejecuta `cortex_search`
THEN el texto de error empieza con `Error en cortex_search:`, contiene `Base de datos no disponible` y no contiene `db.ejemplo.interno` ni `5432`

### Requirement: Expiración de sesiones MCP inactivas

El servidor SHALL registrar la última actividad de cada sesión MCP —cualquier request POST, GET o DELETE con su `mcp-session-id`— y, mediante un barrido cada 60 s, cerrar su transport y quitarla del registro cuando lleve inactiva más del TTL. El TTL SHALL tomarse de `MCP_SESSION_TTL_MINUTES` y valer 1440 por defecto; un valor no numérico o menor que 1 SHALL usar el defecto y registrar un aviso. Razón: las sesiones abandonadas sin DELETE no expiraban nunca.

#### Scenario: Sesión inactiva más allá del TTL

GIVEN una sesión con última actividad hace TTL + 1 ms
WHEN corre el barrido
THEN la sesión deja de estar en el registro y su transport queda cerrado

#### Scenario: Sesión activa dentro del TTL

GIVEN una sesión con última actividad hace TTL − 1 min
WHEN corre el barrido
THEN la sesión sigue en el registro

#### Scenario: La actividad renueva el TTL

GIVEN una sesión con última actividad hace TTL − 1 min
WHEN llega una request con su `mcp-session-id` y después corre el barrido en TTL − 1 min más
THEN la sesión sigue en el registro

#### Scenario: TTL inválido

GIVEN `MCP_SESSION_TTL_MINUTES=abc`
WHEN el servidor arranca
THEN usa 1440 minutos y deja un aviso en el log

### Requirement: Alta y baja de sesiones quedan en el log

El servidor SHALL escribir una línea de log al crear una sesión y otra al cerrarla, con los primeros 8 caracteres del id, la cantidad de sesiones activas y, al cerrar, el motivo (`delete`, `ttl` o `shutdown`). Razón: sin ese rastro, una ola de 404 tras un reinicio no se distingue de sesiones expiradas.

#### Scenario: Ciclo de una sesión en el log

GIVEN el servidor levantado
WHEN un cliente hace `initialize` y luego DELETE de su sesión
THEN el log tiene una línea `sesión creada` y una `sesión cerrada motivo=delete`, ambas con los 8 primeros caracteres del id

### Requirement: Sesión desconocida responde 404 JSON-RPC

Una request a `/mcp` con un `mcp-session-id` que no está en el registro SHALL responder HTTP 404 con cuerpo JSON-RPC `{"jsonrpc":"2.0","error":{"code":-32001,"message":...},"id":null}`, el mismo formato que usa el transport del SDK. Un `initialize` sin `mcp-session-id` SHALL seguir creando una sesión nueva. Razón: la spec MCP manda que el cliente reinicialice ante un 404 de sesión; que lo haga solo depende de cada cliente.

#### Scenario: Request con sesión de un proceso anterior

GIVEN un `mcp-session-id` que no está en el registro (p. ej. de antes de un reinicio)
WHEN se envía `tools/list` con ese id
THEN responde 404 con `error.code` igual a -32001 y `id` igual a null

#### Scenario: Reinicializar tras el 404

GIVEN la respuesta 404 del escenario anterior
WHEN el cliente envía `initialize` sin `mcp-session-id`
THEN responde 200 con un `mcp-session-id` nuevo y `tools/list` con ese id responde las siete tools

### Requirement: Cierre limpio ante SIGTERM y SIGINT

Al recibir SIGTERM o SIGINT el proceso SHALL, en este orden: escribir una línea de log, cerrar todas las sesiones MCP, dejar de aceptar conexiones esperando las requests en curso hasta 8 s, ejecutar `prisma.$disconnect()` y salir con código 0. Si el cierre supera 8 s SHALL salir con código 1; una segunda señal SHALL salir de inmediato con código 1. Razón: `docker stop` espera 10 s antes de SIGKILL; sin cierre, las conexiones a Postgres quedan colgadas hasta que el servidor las expira.

#### Scenario: Cierre con requests en curso

GIVEN el servidor con una sesión abierta y una request lenta en curso
WHEN el proceso recibe SIGTERM
THEN la request en curso termina, las sesiones se cierran, se llama a `prisma.$disconnect()` y el proceso sale con código 0 en menos de 10 s

#### Scenario: Cierre que no termina

GIVEN una request en curso que no termina en 8 s
WHEN el proceso recibe SIGTERM
THEN el proceso sale con código 1 a los 8 s

#### Scenario: Doble señal

GIVEN un cierre en curso
WHEN llega una segunda señal
THEN el proceso sale de inmediato con código 1 sin esperar

### Requirement: Errores no capturados terminan el proceso con log

El proceso SHALL registrar con stack cualquier `uncaughtException` o `unhandledRejection` y terminar con código 1 tras el mismo cierre limpio. Razón: seguir vivo tras un error no capturado deja el servidor en un estado desconocido; con `restart: unless-stopped` el contenedor vuelve solo.

#### Scenario: Promesa rechazada sin capturar

GIVEN el servidor levantado
WHEN ocurre un `unhandledRejection`
THEN el log registra el error con su stack y el proceso termina con código 1

### Requirement: El README explica qué pasa con un contenedor unhealthy

El README SHALL explicar que en Docker Compose un contenedor `unhealthy` no se reinicia solo (con `restart: unless-stopped` ni con `restart: always`), que Cortex se recupera solo cuando la base vuelve sin reiniciarlo, que un reinicio del servidor invalida las sesiones MCP y exige reinicializar el cliente, y cómo configurar `MCP_SESSION_TTL_MINUTES`. Razón: quien ve `unhealthy` en `docker ps` necesita saber si debe actuar.

#### Scenario: El lector encuentra la sección

GIVEN el README del repo
WHEN un lector busca qué hacer con un contenedor `unhealthy`
THEN encuentra una sección que cubre los cuatro puntos y nombra `MCP_SESSION_TTL_MINUTES`
