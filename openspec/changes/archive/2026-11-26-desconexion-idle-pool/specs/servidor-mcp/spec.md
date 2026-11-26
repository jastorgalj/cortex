## MODIFIED Requirements

### Requirement: Healthcheck

`GET /health` SHALL responder 200 con `{status: "ok", notes, db_pool: "active", model_loaded, sessions, uptime_s}` cuando la DB responde, y 503 con `{status: "degraded", db: "down", model_loaded, sessions, uptime_s, error}` cuando la DB falla o no responde en 3 s. Con el pool inactivo SHALL aplicar el requirement «El health no consulta la DB con el pool inactivo». El campo `error` SHALL ser un texto fijo, no el mensaje de Prisma. Razón: es la señal del healthcheck de Docker y el diagnóstico más barato; un 500 genérico no distingue «BD caída» de «bug», y el mensaje de Prisma trae host y puerto de la base.

#### Scenario: Health con el servicio sano

GIVEN el servidor levantado con la DB inicializada
WHEN se consulta `GET /health`
THEN responde 200 con `status: "ok"`, el conteo de notas, `db_pool: "active"`, el estado del modelo, `sessions` (entero ≥ 0) y `uptime_s` (entero ≥ 0)

#### Scenario: Health con la BD caída

GIVEN el servidor levantado y la DB pausada o detenida
WHEN se consulta `GET /health`
THEN responde 503 en menos de 5 s con `status: "degraded"` y `db: "down"`, y el cuerpo no contiene el host ni el puerto de la base

#### Scenario: Health se recupera sin reiniciar

GIVEN el servidor levantado, la DB caída y `GET /health` respondiendo 503
WHEN la DB vuelve a estar disponible
THEN el siguiente `GET /health` dentro de los 40 s siguientes responde 200, sin reiniciar el proceso

### Requirement: El compose reenvía las variables de configuración documentadas

`docker-compose.yml` SHALL reenviar al servicio `server` cada variable que `.env.example` documenta como configurable, incluidas `CORTEX_STRICT_NOTES`, `MCP_SESSION_TTL_MINUTES` y `DB_IDLE_DISCONNECT_MINUTES`; `MCP_SESSION_TTL_MINUTES` con defecto `1440` y `DB_IDLE_DISCONNECT_MINUTES` con defecto `4`, porque una cadena vacía deja un aviso en el log en cada arranque. Razón: una variable que el `.env` documenta pero el compose no reenvía no tiene efecto en `docker compose up`.

#### Scenario: Las variables llegan al contenedor

GIVEN `CORTEX_STRICT_NOTES=1` y `MCP_SESSION_TTL_MINUTES=5` en el entorno del shell
WHEN se ejecuta `docker compose -f docker-compose.yml config`
THEN el `environment` del servicio `server` contiene `CORTEX_STRICT_NOTES: "1"` y `MCP_SESSION_TTL_MINUTES: "5"`

#### Scenario: Sin la variable el TTL vale 1440 sin aviso

GIVEN `MCP_SESSION_TTL_MINUTES` ausente del entorno
WHEN se ejecuta `docker compose -f docker-compose.yml config`
THEN el `environment` del servicio `server` contiene `MCP_SESSION_TTL_MINUTES: "1440"`

#### Scenario: Sin la variable el plazo de desconexión vale 4

GIVEN `DB_IDLE_DISCONNECT_MINUTES` ausente del entorno
WHEN se ejecuta `docker compose -f docker-compose.yml config`
THEN el `environment` del servicio `server` contiene `DB_IDLE_DISCONNECT_MINUTES: "4"`

#### Scenario: El plazo de desconexión llega al contenedor

GIVEN `DB_IDLE_DISCONNECT_MINUTES=0` en el entorno del shell
WHEN se ejecuta `docker compose -f docker-compose.yml config`
THEN el `environment` del servicio `server` contiene `DB_IDLE_DISCONNECT_MINUTES: "0"`

## ADDED Requirements

### Requirement: El pool de la DB se desconecta tras un período sin actividad

El servidor SHALL llamar a `rawPrisma.$disconnect()` cuando pasen `DB_IDLE_DISCONNECT_MINUTES` minutos sin actividad de base de datos, contados desde el arranque del proceso si aún no hubo ninguna. Razón: con Neon, un pool abierto y un sondeo periódico mantienen el compute despierto y facturando; sin tráfico de usuarios el servidor debe dejar de tocar la base.

#### Scenario: Pool sin actividad se desconecta

GIVEN `DB_IDLE_DISCONNECT_MINUTES=4` y un reloj simulado
WHEN pasan 4 minutos sin ninguna operación
THEN se llama a `$disconnect()` exactamente 1 vez

#### Scenario: Sin ninguna operación desde el arranque

GIVEN `DB_IDLE_DISCONNECT_MINUTES=4` y el servidor recién creado
WHEN pasan 4 minutos sin ninguna operación
THEN se llama a `$disconnect()` exactamente 1 vez

#### Scenario: Un $disconnect que falla se reintenta

GIVEN un `$disconnect()` que rechaza
WHEN se cumple el plazo
THEN el error queda en el log, el estado no pasa a inactivo y se vuelve a programar el plazo completo

### Requirement: Qué cuenta como actividad de base de datos

Cuenta como actividad cada operación que pasa por el cliente con reintentos (`prisma` de `src/db/client.ts`: tools MCP, `/api/*` y vista web), registrada al empezar y al terminar. `GET /health` SHALL NOT contar como actividad, porque su sondeo usa `rawPrisma` y existe justamente para no depender del tráfico. Razón: si el health contara, el sondeo de Docker cada 30 s mantendría el pool vivo para siempre.

#### Scenario: La actividad renueva el plazo

GIVEN `DB_IDLE_DISCONNECT_MINUTES=4` y una operación a los 3 minutos
WHEN transcurre 1 minuto más
THEN no se ha llamado a `$disconnect()`, y se llama 4 minutos después de la operación

#### Scenario: La actividad se registra también al terminar

GIVEN `DB_IDLE_DISCONNECT_MINUTES=4` y una operación que empieza en el minuto 0 y termina en el minuto 3
WHEN llega el minuto 6
THEN no se ha llamado a `$disconnect()`, y se llama en el minuto 7

#### Scenario: El health no mantiene vivo el pool

GIVEN `DB_IDLE_DISCONNECT_MINUTES=4` y un `GET /health` cada 30 s durante 5 minutos sin otras operaciones
WHEN se cumplen 4 minutos desde la última operación
THEN se llama a `$disconnect()`

### Requirement: DB_IDLE_DISCONNECT_MINUTES configura el plazo

`DB_IDLE_DISCONNECT_MINUTES` SHALL aceptar un número de minutos mayor o igual a 0: ausente o vacía vale 4 sin aviso, `0` desactiva la desconexión, y un valor no numérico o negativo vale 4 y deja un aviso en el log con el valor recibido. Razón: la misma convención que `MCP_SESSION_TTL_MINUTES`, más un valor explícito para quien no quiere el comportamiento (Postgres local).

#### Scenario: Ausente usa 4

GIVEN `DB_IDLE_DISCONNECT_MINUTES` ausente o vacía
WHEN el servidor arranca
THEN el plazo es de 4 minutos y no hay aviso en el log

#### Scenario: Cero desactiva

GIVEN `DB_IDLE_DISCONNECT_MINUTES=0`
WHEN pasan 60 minutos simulados sin actividad
THEN no se llama a `$disconnect()` y `GET /health` nunca responde `db_pool: "idle"`

#### Scenario: Valor inválido usa 4 con aviso

GIVEN `DB_IDLE_DISCONNECT_MINUTES=abc` o `-3`
WHEN el servidor arranca
THEN el plazo es de 4 minutos y el log trae un aviso que nombra la variable y el valor recibido

### Requirement: Tras la desconexión la siguiente request reconecta sola

Tras una desconexión por inactividad, la primera operación contra la DB SHALL ejecutarse con normalidad: el cliente reconecta en forma perezosa y los reintentos existentes («Reintento ante fallos de conexión con la BD») cubren el despertar de la base. Este requirement SHALL NOT cambiar los reintentos ni sus esperas. Razón: Neon tarda de cientos de milisegundos a pocos segundos en despertar y esa espera ya cabe en el presupuesto de 8 s.

#### Scenario: Lectura tras la desconexión

GIVEN una nota existente y el pool desconectado por inactividad
WHEN se pide la nota con `cortex_read`
THEN la respuesta trae la nota, sin error

#### Scenario: Despertar lento de la base

GIVEN el pool desconectado y un cliente falso cuya primera conexión falla con P1001
WHEN llega una operación de lectura
THEN se reintenta con el mecanismo existente y la operación termina con éxito

### Requirement: El health no consulta la DB con el pool inactivo

Con el pool desconectado por inactividad, `GET /health` SHALL responder 200 con `{status: "ok", db_pool: "idle", model_loaded, sessions, uptime_s}`, sin `notes`, sin ejecutar consultas y sin reconectar el pool. Razón: el healthcheck de Docker corre cada 30 s también contra una base externa; si consultara la DB en inactividad, Neon nunca suspendería.

#### Scenario: Health con el pool inactivo no toca la BD

GIVEN el pool desconectado por inactividad y un `countNotes` espiado
WHEN se consulta `GET /health` 3 veces
THEN las 3 respuestas son 200 con `db_pool: "idle"`, ninguna trae `notes` y `countNotes` se llamó 0 veces

#### Scenario: Health tras actividad vuelve a consultar

GIVEN el pool inactivo y luego una operación de usuario
WHEN se consulta `GET /health`
THEN responde 200 con `db_pool: "active"` y `notes`, y `countNotes` se llamó 1 vez

#### Scenario: Actividad durante la desconexión no deja el pool como inactivo

GIVEN un `$disconnect()` en curso y una operación de usuario que llega antes de que termine
WHEN el `$disconnect()` termina
THEN `GET /health` responde con `db_pool: "active"`

### Requirement: El temporizador de inactividad no retiene el proceso

El temporizador de desconexión SHALL ser `unref` y el cierre limpio («Cierre limpio ante SIGTERM y SIGINT») SHALL cancelarlo antes de `prisma.$disconnect()`. Razón: un temporizador vivo impediría que `bun test` y el proceso terminen, y un `$disconnect()` del temporizador durante el cierre competiría con el del cierre.

#### Scenario: Temporizador unref

GIVEN un temporizador falso inyectado
WHEN se crea la desconexión por inactividad con plazo mayor que 0
THEN el temporizador creado recibió `unref()`

#### Scenario: El cierre cancela el temporizador

GIVEN una desconexión por inactividad con el temporizador armado
WHEN se ejecuta el cierre limpio
THEN el temporizador queda cancelado y no se llama a `$disconnect()` desde él

### Requirement: La documentación explica la desconexión por inactividad

`README.md`, `CONTRIBUTING.md` y `.env.example` SHALL documentar `DB_IDLE_DISCONNECT_MINUTES` (defecto 4, `0` la desactiva), y la sección del README sobre `unhealthy` SHALL explicar que con `db_pool: "idle"` `/health` no consulta la base. Razón: quien ve `db_pool: "idle"` o una primera request más lenta tras un rato sin uso debe saber que es esperado.

#### Scenario: El lector encuentra la variable

GIVEN `README.md`, `CONTRIBUTING.md` y `.env.example`
WHEN se busca `DB_IDLE_DISCONNECT_MINUTES` en cada uno
THEN los tres la nombran, y `README.md` nombra además `db_pool` y `idle`
