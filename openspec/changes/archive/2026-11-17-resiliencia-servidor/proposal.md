## Why

El 12-11 los clientes MCP vieron ~8 min de errores de socket contra Cortex (GitHub #16). Hoy el servidor no distingue «BD caída» de «bug» en `/health` (`src/index.ts:17-20`, `prisma.note.count` sin manejo de error), no reintenta fallos transitorios de Postgres, nunca expira las sesiones MCP abandonadas (`src/tools/mcp-server.ts:32`, solo se limpia en DELETE explícito `:403-405`) y no tiene cierre limpio ante `docker stop` (`grep SIGTERM|SIGINT|disconnect src/` solo encuentra `src/import.ts:371`).

## What Changes

- `/health` responde 503 `{status:"degraded", db:"down"}` en < 5 s con la BD caída o colgada, un solo sondeo en curso, y 200 al volver la BD.
- Reintento (3, con espera corta) ante fallos de conexión en las tools; las escrituras no reintentan lo que pudo haberse aplicado. Mensaje claro al agente al agotar.
- Sesiones MCP: última actividad, TTL configurable con barrido, log de alta/baja, 404 con cuerpo JSON-RPC ante sesión desconocida.
- SIGTERM/SIGINT con cierre limpio (sesiones, servidor, `prisma.$disconnect()`); `uncaughtException`/`unhandledRejection` con log y salida 1.
- README: qué significa `unhealthy` en Compose y qué hacer.

## Fuera de alcance

- Publicación de imagen (GHCR), release y bump de versión.
- Modo sin sesiones (stateless) en `/mcp`: eliminaría TTL y 404, pero cambia el contrato y no está probado con los clientes. Queda como follow-up.
- Mapear errores de BD a 503 en la API REST y la vista web (`/api/*`, `/`, `/notes/:id`): hoy dan 500 de Elysia; no lo pide el criterio de aceptación.
- Salir del proceso tras N fallos de BD o autoheal: Prisma reconecta solo (verificado con la BD pausada y reanudada), y un reinicio invalidaría todas las sesiones.
- Configuración de pool/timeouts de Prisma (`src/db/client.ts:4`): los timeouts se resuelven con `Promise.race` en `/health` y el presupuesto de reintentos.

## Impact

- Archivos nuevos: `src/db/retry.ts`, `src/health.ts`, `src/tools/sessions.ts`, `src/shutdown.ts` y sus tests.
- Archivos editados: `src/db/client.ts`, `src/index.ts`, `src/tools/mcp-server.ts` (solo registro de sesiones, `createSession`, `handleMcpRequest`; no las tools), `README.md`, `CONTRIBUTING.md`, `test/api.test.ts`.
- Spec: capability `servidor-mcp` (1 requirement MODIFIED, 10 ADDED). Sin migraciones ni cambios de esquema.
