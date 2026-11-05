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
falta o qué id no existe) que nombren la tool con su nombre vigente, nunca errores opacos. Razón:
los consumidores son agentes — un error que no dice qué corregir produce reintentos a ciegas.

#### Scenario: Los mensajes de error usan los nombres nuevos

GIVEN el servidor levantado
WHEN se llama `cortex_read` con un id inexistente
THEN el mensaje de error empieza con `Error en cortex_read` y no contiene la cadena `kb_`

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
