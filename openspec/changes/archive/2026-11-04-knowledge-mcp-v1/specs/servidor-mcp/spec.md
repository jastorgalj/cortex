# servidor-mcp — Delta

## Purpose

El contrato del servidor central: seis tools MCP sobre HTTP streamable, vista web de solo
lectura, healthcheck y empaquetado Docker, en un solo proceso Bun/Elysia.

## ADDED Requirements

### Requirement: Seis tools MCP sobre HTTP streamable

El servidor SHALL exponer bajo `/mcp` (transporte HTTP streamable del SDK oficial) exactamente
estas tools: `kb_search`, `kb_read`, `kb_write`, `kb_update`, `kb_list`, `kb_history`. Cada
tool SHALL declarar su schema de parámetros y responder errores descriptivos (qué parámetro
falta o qué id no existe), nunca errores opacos. Razón: los consumidores son agentes — un
error que no dice qué corregir produce reintentos a ciegas.

#### Scenario: tools/list devuelve exactamente seis

GIVEN el servidor levantado
WHEN un cliente MCP envía `tools/list`
THEN la respuesta contiene exactamente las seis tools nombradas y ninguna otra

#### Scenario: Ciclo completo por MCP

GIVEN un cliente MCP conectado
WHEN ejecuta en orden kb_write (con author), kb_search del contenido, kb_read del id,
kb_update con motivo y kb_history
THEN cada llamada responde éxito y la historia final contiene 1 revisión

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
`GET /api/notes/:id` respondiendo JSON con los mismos resultados que `kb_search` y `kb_read`.
Ningún método de escritura SHALL existir bajo `/api`. Razón: scripts, CI y debugging necesitan
acceso sin cliente MCP; la escritura queda concentrada en `/mcp`, donde viven la validación,
las revisiones y la deduplicación.

#### Scenario: Búsqueda por curl coincide con la tool

GIVEN un corpus con notas
WHEN se consulta `GET /api/search?q=<términos>` y `kb_search` con los mismos términos
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
