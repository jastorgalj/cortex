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

`GET /health` SHALL responder `{status, notes, model_loaded}` con código 200 cuando la DB es
accesible. Razón: es la señal que usa el healthcheck de Docker y el diagnóstico más barato
cuando «no funciona».

#### Scenario: Health con el servicio sano

GIVEN el servidor levantado con la DB inicializada
WHEN se consulta `GET /health`
THEN responde 200 con el conteo de notas y el estado del modelo

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
