## REMOVED Requirements

### Requirement: Siete tools MCP con prefijo cortex_ sobre HTTP streamable

**Reason**: Falso desde que `cortex_apps` (requirement «`cortex_apps` expone el vocabulario y los conteos») existe: el servidor expone ocho tools y el scenario «tools/list devuelve exactamente siete» falla contra `src/tools/mcp-server.ts` (ocho llamadas `server.tool(...)`). Dos requirements vigentes se contradicen: éste dice «exactamente siete» y el de `cortex_apps` agrega una octava.
**Migration**: Reemplazado por «Ocho tools MCP con prefijo cortex_ sobre HTTP streamable» (ADDED en este mismo delta).

## ADDED Requirements

### Requirement: Ocho tools MCP con prefijo cortex_ sobre HTTP streamable

El servidor SHALL exponer bajo `/mcp` (transporte HTTP streamable del SDK oficial) exactamente estas tools: `cortex_search`, `cortex_read`, `cortex_write`, `cortex_update`, `cortex_list`, `cortex_apps`, `cortex_history`, `cortex_delete`. Ninguna tool con prefijo `kb_` SHALL existir. Razón: un alias `kb_*` mostraría a los agentes dos nombres para la misma operación y rompería el contrato de exactamente ocho.

#### Scenario: tools/list devuelve exactamente ocho

GIVEN el servidor levantado
WHEN un cliente MCP envía `tools/list`
THEN la respuesta contiene exactamente las ocho tools nombradas y ninguna otra, y ningún nombre empieza con `kb_`

#### Scenario: Ciclo completo por MCP con borrado

GIVEN un cliente MCP conectado
WHEN ejecuta en orden cortex_write (con author), cortex_search del contenido, cortex_read del id, cortex_update con motivo, cortex_history y cortex_delete con author y motivo
THEN cada llamada responde éxito, el historial previo al borrado contiene 1 revisión y la nota borrada ya no aparece en cortex_list

### Requirement: El compose reenvía las variables de configuración documentadas

`docker-compose.yml` SHALL reenviar al servicio `server` cada variable que `.env.example` documenta como configurable, incluidas `CORTEX_STRICT_NOTES` y `MCP_SESSION_TTL_MINUTES`; esta última con defecto `1440`, porque una cadena vacía deja un aviso en el log en cada arranque. Razón: una variable que el `.env` documenta pero el compose no reenvía no tiene efecto en `docker compose up`.

#### Scenario: Las variables llegan al contenedor

GIVEN `CORTEX_STRICT_NOTES=1` y `MCP_SESSION_TTL_MINUTES=5` en el entorno del shell
WHEN se ejecuta `docker compose -f docker-compose.yml config`
THEN el `environment` del servicio `server` contiene `CORTEX_STRICT_NOTES: "1"` y `MCP_SESSION_TTL_MINUTES: "5"`

#### Scenario: Sin la variable el TTL vale 1440 sin aviso

GIVEN `MCP_SESSION_TTL_MINUTES` ausente del entorno
WHEN se ejecuta `docker compose -f docker-compose.yml config`
THEN el `environment` del servicio `server` contiene `MCP_SESSION_TTL_MINUTES: "1440"`

## MODIFIED Requirements

### Requirement: El servidor se identifica como Cortex

El servidor SHALL identificarse como `cortex` en el `serverInfo.name` de la respuesta `initialize` MCP, con `serverInfo.version` igual al campo `version` de `package.json`; la vista web SHALL mostrar «Cortex» en el título de la página y en el encabezado del listado; y `package.json` SHALL llevar `name: "cortex"`. Razón: es el nombre que ven el equipo y los agentes en Hermes y en el navegador; la versión sale de `package.json` (`src/tools/mcp-server.ts:34-36`) para que anuncio y paquete no diverjan, y un literal en el spec envejece en cada release.

#### Scenario: El initialize nombra al servidor

GIVEN el servidor levantado
WHEN un cliente MCP envía `initialize`
THEN `serverInfo.name` es `cortex` y `serverInfo.version` es igual al `version` de `package.json`

#### Scenario: La vista web dice Cortex

GIVEN el servidor levantado con al menos una nota
WHEN se abre `GET /` y `GET /notes/<id>`
THEN el `<title>` de ambas páginas contiene «Cortex» y ninguna contiene «Novara KB»

### Requirement: Sesión desconocida responde 404 JSON-RPC

Una request a `/mcp` con un `mcp-session-id` que no está en el registro SHALL responder HTTP 404 con cuerpo JSON-RPC `{"jsonrpc":"2.0","error":{"code":-32001,"message":...},"id":null}`, el mismo formato que usa el transport del SDK. Un `initialize` sin `mcp-session-id` SHALL seguir creando una sesión nueva. Razón: la spec MCP manda que el cliente reinicialice ante un 404 de sesión; que lo haga solo depende de cada cliente.

#### Scenario: Request con sesión de un proceso anterior

GIVEN un `mcp-session-id` que no está en el registro (p. ej. de antes de un reinicio)
WHEN se envía `tools/list` con ese id
THEN responde 404 con `error.code` igual a -32001 y `id` igual a null

#### Scenario: Reinicializar tras el 404

GIVEN la respuesta 404 del escenario anterior
WHEN el cliente envía `initialize` sin `mcp-session-id`
THEN responde 200 con un `mcp-session-id` nuevo y `tools/list` con ese id responde las ocho tools

### Requirement: Las respuestas JSON de las tools son compactas

Toda respuesta exitosa de las ocho tools que lleve JSON, incluida la de `similar_exists` de `cortex_write` y la de `cortex_apps`, SHALL serializarse sin indentación ni saltos de línea entre elementos, de modo que su texto sea igual a `JSON.stringify(JSON.parse(texto))`.

#### Scenario: Ninguna tool indenta

GIVEN el servidor levantado y notas existentes, entre ellas dos casi idénticas
WHEN se ejecutan con éxito `cortex_search`, `cortex_read`, `cortex_write` (nota nueva), `cortex_write` que responde `similar_exists`, `cortex_update`, `cortex_list`, `cortex_apps`, `cortex_history` y `cortex_delete`
THEN el texto de cada respuesta es igual a `JSON.stringify(JSON.parse(texto))`

### Requirement: API REST de solo lectura

El proceso SHALL exponer `GET /api/search` (parámetros q, app, include_general, kind, issue, tags, limit), `GET /api/apps` y `GET /api/notes/:id` respondiendo JSON con los mismos resultados que `cortex_search`, `cortex_apps` y `cortex_read`. Ningún método de escritura SHALL existir bajo `/api`. Razón: scripts, CI y debugging necesitan acceso sin cliente MCP; la escritura queda concentrada en `/mcp`, donde viven la validación, las revisiones y la deduplicación.

#### Scenario: Búsqueda por curl coincide con la tool

GIVEN un corpus con notas
WHEN se consulta `GET /api/search?q=<términos>` y `cortex_search` con los mismos términos
THEN ambos devuelven los mismos ids en el mismo orden

#### Scenario: Escritura por REST inexistente

GIVEN el servidor levantado
WHEN se envía POST/PUT/PATCH/DELETE a cualquier ruta bajo `/api`
THEN responde 404 o 405 y ninguna nota cambia
