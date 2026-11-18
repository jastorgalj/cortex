# Proposal — Alias de argumentos, `author` por defecto e `issue: null` en `cortex_write`

## Why

En uso real los agentes fallan llamadas por detalles del nombre de un argumento (GitHub #11):
`query` en vez de `q` en `cortex_search`; `body` o `content` en vez de `body_md` en
`cortex_write`/`cortex_update`; `author` omitido (8 casos solo en `cortex_update`); `issue: null` en
`cortex_write`. Cada fallo cuesta un turno y a veces el agente abandona el guardado.

Medido en el SDK del repo (`@modelcontextprotocol/sdk` 1.32.2 + zod 4.6.7, sonda en memoria):

- Hoy `{query:"x"}` falla con `Input validation error ... expected string, received undefined at q`
  (sin pista del alias); una clave desconocida junto a la canónica se **descarta en silencio**
  (`{q:"x", query:"y"}` ejecuta con `q:"x"`).
- Declarar el alias en el schema lo duplica en `tools/list` y además **borra `required`** (todo pasa a
  opcional). `z.preprocess` sobre el objeto hace que `tools/list` devuelva `properties: {}`
  (el agente pierde el schema entero). Ninguna de las dos sirve.
- Envolver `transport.onmessage` (API pública del `Transport`) permite renombrar los argumentos antes de
  que el SDK valide: `tools/list` queda idéntico y la request trae el header por-request
  (`extra.requestInfo.headers`). `clientInfo.name` sale de `server.server.getClientVersion()`.

## What Changes

- **Alias** (`query`|`text` → `q` en `cortex_search`; `body`|`content`|`markdown` → `body_md` en
  `cortex_write` y `cortex_update`), resueltos antes de validar, **sin aparecer en `tools/list`**.
  Canónico y alias con valores distintos → error explícito que nombra ambos.
- **`author` opcional** en `cortex_write` y `cortex_update`: argumento > header `x-cortex-author` >
  `clientInfo.name` > `'agente'`. Un `author` enviado pero vacío sigue rechazado (escenario vigente).
- **`cortex_write` acepta `issue: null`**; `null`, vacío o solo espacios se guardan como `NULL`.
  (`cortex_update` ya lo acepta desde #13/#14 — no se toca.)
- **Docs**: `README.md` y `skills/cortex-mcp/SKILL.md` documentan alias y el default de `author`.

## Capabilities

### New Capabilities

Ninguna.

### Modified Capabilities

- `servidor-mcp`: requirements nuevos (alias, conflicto de alias, `author` opcional, `cortex_delete`
  conserva `author` obligatorio, schema de `cortex_write` declara `issue` nullable).
- `notas`: requirement nuevo (la creación normaliza `issue` null/vacío a `NULL`).

Ningún requirement ni escenario vigente cambia de texto (verificado en `design.md`, D8); por eso no hay
bloque MODIFIED.

## Fuera de alcance

- `cortex_update` con `issue: null`: ya hecho por #13/#14 (`src/tools/mcp-server.ts:210-214`,
  `src/db/notes.ts:398`, spec `notas` «La actualización puede corregir o quitar el issue»).
- `issue: ""` en `cortex_update`: sigue siendo error (escenario vigente «issue vacío rechazado»).
- Rechazar claves desconocidas que no son alias (hoy se descartan en silencio): decisión P2 de la propuesta.
- Alias para `cortex_read`/`cortex_history`/`cortex_delete`/`cortex_list` (el issue no los pide).
- Paginación y tamaño de respuestas (#17), imagen GHCR, release y bump de versión.
