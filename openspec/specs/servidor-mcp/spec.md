# servidor-mcp Specification

## Purpose
El contrato del servidor central: siete tools MCP sobre HTTP streamable, vista web de solo
lectura, healthcheck y empaquetado Docker, en un solo proceso Bun/Elysia.

## Requirements

### Requirement: Vista web de solo lectura

El proceso SHALL servir `GET /` con el listado de notas (título, tags, autor, fecha, orden
updated_at descendente) y `GET /notes/:id` con el markdown renderizado. SHALL no existir ningún
endpoint HTTP de escritura fuera de `/mcp`. Razón: consulta humana directa sin agente; la
escritura pasa siempre por las tools para conservar validación, revisiones y deduplicación.

#### Scenario: Lectura humana de una nota

GIVEN una nota existente
WHEN se abre `/notes/<id>` en un navegador
THEN se ve el título, el markdown renderizado, los tags, el autor y la fecha

#### Scenario: No hay escritura por HTTP plano

GIVEN el servidor levantado
WHEN se envía POST/PUT/DELETE a `/` o `/notes/:id`
THEN responde 404 o 405, y ninguna nota cambia

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

### Requirement: API REST de solo lectura

El proceso SHALL exponer `GET /api/search` (parámetros q, app, kind, tags, limit) y
`GET /api/notes/:id` respondiendo JSON con los mismos resultados que `cortex_search` y
`cortex_read`. Ningún método de escritura SHALL existir bajo `/api`. Razón: scripts, CI y
debugging necesitan acceso sin cliente MCP; la escritura queda concentrada en `/mcp`, donde
viven la validación, las revisiones y la deduplicación.

#### Scenario: Búsqueda por curl coincide con la tool

GIVEN un corpus con notas
WHEN se consulta `GET /api/search?q=<términos>` y `cortex_search` con los mismos términos
THEN ambos devuelven los mismos ids en el mismo orden

#### Scenario: Escritura por REST inexistente

GIVEN el servidor levantado
WHEN se envía POST/PUT/PATCH/DELETE a cualquier ruta bajo `/api`
THEN responde 404 o 405 y ninguna nota cambia

### Requirement: Empaquetado Docker con DB externa

El repo SHALL incluir Dockerfile del server y docker-compose.yml con un servicio Postgres con
pgvector (con volumen) para desarrollo y tests; el server SHALL leer la conexión de
`DATABASE_URL`, sin ninguna ruta de datos local salvo el cache del modelo ONNX (en volumen).
Recrear el contenedor del server SHALL no perder notas ni re-descargar el modelo. Razón: la DB
vive fuera del server (Neon hoy, cualquier Postgres después) — el server debe ser
desechable.

#### Scenario: El server es desechable

GIVEN `docker compose up` con una nota escrita
WHEN se elimina el contenedor del server y se vuelve a levantar apuntando a la misma
`DATABASE_URL` y el mismo volumen de cache
THEN la nota sigue existiendo y `/health` reporta `model_loaded` sin descarga nueva

### Requirement: Siete tools MCP con prefijo cortex_ sobre HTTP streamable

El servidor SHALL exponer bajo `/mcp` (transporte HTTP streamable del SDK oficial) exactamente
estas tools: `cortex_search`, `cortex_read`, `cortex_write`, `cortex_update`, `cortex_list`,
`cortex_history`, `cortex_delete`. Ninguna tool con prefijo `kb_` SHALL existir. Razón: un alias
`kb_*` mostraría a los agentes dos nombres para la misma operación y rompería el contrato de
exactamente siete.

#### Scenario: tools/list devuelve exactamente siete

GIVEN el servidor levantado
WHEN un cliente MCP envía `tools/list`
THEN la respuesta contiene exactamente las siete tools nombradas y ninguna otra, y ningún nombre
empieza con `kb_`

#### Scenario: Ciclo completo por MCP con borrado

GIVEN un cliente MCP conectado
WHEN ejecuta en orden cortex_write (con author), cortex_search del contenido, cortex_read del id,
cortex_update con motivo, cortex_history y cortex_delete con author y motivo
THEN cada llamada responde éxito, el historial previo al borrado contiene 1 revisión y la nota
borrada ya no aparece en cortex_list

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

### Requirement: El servidor se identifica como Cortex

El servidor SHALL identificarse como `cortex` en el `serverInfo.name` de la respuesta `initialize`
MCP, con versión `0.2.0`; la vista web SHALL mostrar «Cortex» en el título de la página y en el
encabezado del listado; y `package.json` SHALL llevar `name: "cortex"` y `version: "0.2.0"`.
Razón: es el nombre que ven el equipo y los agentes en Hermes y en el navegador; mientras diga
`novara-knowledge-mcp` o `Novara KB`, el producto no tiene identidad.

#### Scenario: El initialize nombra al servidor

GIVEN el servidor levantado
WHEN un cliente MCP envía `initialize`
THEN `serverInfo.name` es `cortex` y `serverInfo.version` es `0.2.0`

#### Scenario: La vista web dice Cortex

GIVEN el servidor levantado con al menos una nota
WHEN se abre `GET /` y `GET /notes/<id>`
THEN el `<title>` de ambas páginas contiene «Cortex» y ninguna contiene «Novara KB»

### Requirement: Instalación con Docker Compose reproducible

El README SHALL documentar la instalación completa con Docker Compose desde un checkout limpio
—comandos exactos y verificación—, y esos pasos SHALL dejar `GET /health` en 200 contra una base con
las migraciones aplicadas. Razón: instalar de cero no debe exigir leer el código ni editar archivos
versionados.

#### Scenario: Instalación desde un checkout limpio

- **WHEN** en un checkout limpio se copia la plantilla de configuración a `.env` y se ejecuta
  `docker compose up --build -d`
- **THEN** `GET http://localhost:3091/health` responde 200 y la base queda con las tablas del modelo
  creadas

#### Scenario: El README indica cómo verificar la instalación

- **WHEN** un lector sigue la sección de instalación del README
- **THEN** encuentra el comando de verificación (`GET /health`) y el resultado esperado, sin tener que
  deducirlo del código

### Requirement: La URL de la base se pasa por entorno sin editar el compose

`DATABASE_URL` SHALL poder configurarse por entorno —`.env` junto al `docker-compose.yml` o variable
del shell— sin editar el archivo versionado, y SHALL tener un valor por defecto que apunte al servicio
`db` del compose. La variable del shell SHALL tener precedencia sobre el `.env`. Razón: la base es
externa al proyecto (Neon hoy) y su URL no puede quedar fija en el compose.

#### Scenario: URL apuntada a una base externa

- **WHEN** el `.env` define `DATABASE_URL` apuntando a una base externa (p. ej. Neon)
- **THEN** al levantar los servicios el servidor conecta a esa base sin que se edite
  `docker-compose.yml`

#### Scenario: Sin `.env` se usa el servicio db del compose

- **WHEN** no existe `.env` ni `DATABASE_URL` en el entorno del shell
- **THEN** el servidor conecta al servicio `db` del compose

#### Scenario: El entorno del shell gana sobre el `.env`

- **WHEN** el `.env` y el entorno del shell definen valores distintos de `DATABASE_URL`
- **THEN** el servidor usa la URL del shell

### Requirement: Las migraciones pendientes se aplican al levantar el servicio

Al arrancar el contenedor del servidor —con Docker Compose o con `docker run`—, la imagen SHALL aplicar
las migraciones pendientes sobre la base indicada por `DATABASE_URL` antes de empezar a servir. El README
SHALL advertir que esa migración corre contra la base apuntada, incluida una externa. Razón: una base vacía
debe quedar utilizable sin pasos manuales.

#### Scenario: Base vacía

- **WHEN** se arranca el contenedor contra una base sin tablas (con Compose o con `docker run`)
- **THEN** el contenedor aplica las migraciones pendientes y `GET /health` responde 200 con las tablas del
  modelo creadas, sin ningún paso previo manual

#### Scenario: Base vacía con docker run

- **WHEN** se ejecuta el comando `docker run` documentado contra una base externa vacía
- **THEN** el contenedor aplica las migraciones pendientes sobre esa base y `GET /health` responde 200

#### Scenario: El README advierte que migra la base apuntada

- **WHEN** el lector configura `DATABASE_URL` hacia una base externa
- **THEN** el README le advierte que el arranque aplica las migraciones pendientes sobre esa base

### Requirement: Los servicios arrancan con el sistema operativo

Los servicios `db` y `server` SHALL reiniciarse automáticamente tras un reinicio del host, y el README
SHALL documentar cómo dejar el daemon de Docker arrancando con el sistema —Linux/systemd como camino
principal, y una línea para macOS/Windows—. Razón: un reinicio del host no debe dejar el servidor
caído hasta que alguien lo levante a mano.

#### Scenario: Reinicio del host

- **WHEN** el host se reinicia con los servicios ya levantados y el daemon de Docker habilitado
- **THEN** ambos servicios vuelven a estar arriba sin intervención manual

#### Scenario: Instrucciones por plataforma

- **WHEN** el lector busca cómo dejar Docker arrancando con el sistema
- **THEN** el README da el procedimiento de Linux (systemd) y menciona en una línea macOS y Windows

### Requirement: Imagen Docker publicada y descargable sin checkout

El proyecto SHALL publicar una imagen de contenedor en un registry público descargable sin
autenticación, con los tags `:latest` y `:<version>` derivado del tag git y validado contra la versión
de `package.json` (el workflow falla si difieren); la
publicación SHALL dispararse solo desde un tag o release, nunca desde un push a la rama por defecto ni
desde una card. Razón: el usuario final debe bajar Cortex sin clonar el repo.

#### Scenario: Descarga anónima de la imagen

- **WHEN** un usuario ejecuta `docker pull ghcr.io/jastorgalj/cortex:latest` sin autenticarse
- **THEN** la imagen se descarga y un `docker run` con ella arranca el servidor

#### Scenario: El package es público

- **WHEN** el package de GHCR se ha marcado público tras el primer push
- **THEN** `docker pull ghcr.io/jastorgalj/cortex:latest` sin autenticarse responde con la imagen, no 401

#### Scenario: La publicación solo la dispara un tag

- **WHEN** alguien hace push a `main` sin crear un tag ni un release
- **THEN** no se publica ninguna imagen en el registry

### Requirement: Instalación con `docker run` y base externa

El README SHALL documentar un comando `docker run` único —puerto `3091`, `DATABASE_URL` por `-e`, cache
del modelo en un volumen y `--restart unless-stopped`— que deja `GET /health` en 200 contra la base
apuntada, con las migraciones aplicadas, sin clonar el repo ni editar archivos versionados. Razón: el
entregable pedido es un solo comando donde el usuario solo setea la URL de la base.

#### Scenario: Arranque con la URL de la base

- **WHEN** se ejecuta el comando `docker run` documentado con `-e DATABASE_URL` apuntando a una base
  externa vacía
- **THEN** el contenedor aplica las migraciones y `GET http://localhost:3091/health` responde 200

#### Scenario: El cache del modelo sobrevive

- **WHEN** se recrea el contenedor con el mismo volumen de cache y la misma `DATABASE_URL`
- **THEN** no se re-descarga el modelo y `GET /health` responde 200 con `model_loaded: true`

### Requirement: Instalación de la skill sin clonar el repo

El proyecto SHALL ofrecer un instalador de las skills (`cortex-mcp` y `cortex-mcp-project`) ejecutable
sin clonar el repo —descargable por `curl` a una URL pública y autocontenido—, que instale en Hermes
(`~/.hermes/skills/`) y en Claude Code (`~/.claude/skills/`). Razón: la skill es lo que el agente
necesita para usar el MCP, y hoy exige tener el repo.

#### Scenario: Instalar sin checkout

- **WHEN** un usuario descarga y ejecuta el instalador documentado sin tener el repo clonado
- **THEN** las dos skills quedan instaladas en sus rutas de Hermes y Claude Code

#### Scenario: La skill de proyecto llega completa

- **WHEN** un usuario instala la skill sin clonar el repo
- **THEN** `cortex-mcp-project` queda instalada con su `scripts/verify-initial-migration.sh`, no solo el
  `SKILL.md`

#### Scenario: Un destino ausente no frena al resto

- **WHEN** una raíz destino no existe (p. ej. `~/.claude`)
- **THEN** el instalador salta ese destino con un mensaje y sigue con los demás

### Requirement: Falla rápido si la base no sirve

Al arrancar, si `DATABASE_URL` no apunta a un PostgreSQL 16 con `pgvector` accesible (conexión imposible,
rol sin permisos o extensión faltante), el contenedor SHALL terminar con un mensaje accionable que nombre
`DATABASE_URL` y el requisito de la base, sin dejar el proceso a medias. Razón: un arranque que falla en
silencio deja al usuario reintentando a ciegas.

#### Scenario: Base inaccesible

- **WHEN** se arranca el contenedor con un `DATABASE_URL` que no es accesible
- **THEN** el proceso termina con un mensaje que nombra `DATABASE_URL` y pide revisar que sea un
  PostgreSQL 16 con pgvector

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
