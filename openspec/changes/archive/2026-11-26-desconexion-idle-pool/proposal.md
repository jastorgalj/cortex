## Why

Cortex corre sobre Neon (spec `servidor-mcp`, requirement «La URL de la base se pasa por entorno…»). Neon suspende el compute tras 5 min sin actividad, pero hoy el servidor no deja de tocar la base nunca: el pool de Prisma queda abierto indefinidamente una vez abierto (medido: 1 conexión viva tras 420 s sin llamadas; `$disconnect()` solo se llama en el cierre, `src/index.ts:184`) y el healthcheck de Docker consulta `count(*)` cada 30 s (`docker-compose.yml:38-48`, `Dockerfile:43`, `src/index.ts:25`). Resultado: compute facturando 24 h sin tráfico de usuarios.

## What Changes

- Nuevo `src/db/idle-disconnect.ts`: tras `DB_IDLE_DISCONNECT_MINUTES` (defecto 4, `0` desactiva) sin actividad de base de datos, llama `rawPrisma.$disconnect()`; la siguiente request reconecta sola y los reintentos existentes cubren el despertar de Neon.
- `src/db/retry.ts`: `withDbRetry`/`retryingClient` aceptan `onActivity`, que marca la actividad al empezar y terminar cada operación.
- `src/db/client.ts`: crea y exporta `idleDisconnect` y lo conecta a `prisma`.
- `src/index.ts`: con el pool inactivo `/health` responde 200 `{status:'ok', db_pool:'idle', …}` sin consultar la DB; con pool activo agrega `db_pool:'active'`; el cierre cancela el temporizador.
- `docker-compose.yml`, `.env.example`, `README.md`, `CONTRIBUTING.md`: variable nueva documentada y reenviada (defecto 4).
- `bunfig.toml`: `DB_IDLE_DISCONNECT_MINUTES = "0"` en `[test.env]`.

## Fuera de alcance

- Publicación a npm/GHCR, release y bump de versión: manual del usuario.
- Probar contra Neon real: prohibido; el despertar de Neon no se reproduce en DEV (solo se simula con P1001 falso y con un PG local).
- Keep-alive, `connection_limit`, `max_idle_connection_lifetime` u otros parámetros del pool en la `DATABASE_URL`.
- Timeout propio para un `$disconnect()` colgado: hipótesis sin medir.
- `src/import.ts` (CLI, cliente propio) y los handlers de `src/tools/mcp-server.ts`.
- UAT/PROD: este trabajo llega solo a DEV.

## Impact

- Archivos nuevos: `src/db/idle-disconnect.ts`, `test/idle-disconnect.test.ts`.
- Archivos editados: `src/db/retry.ts`, `src/db/client.ts`, `src/index.ts`, `bunfig.toml`, `docker-compose.yml`, `.env.example`, `README.md`, `CONTRIBUTING.md`, `test/retry.test.ts`, `test/health.test.ts`, `test/api.test.ts`, `test/compose.test.ts`.
- Spec: capability `servidor-mcp` (2 requirements MODIFIED: «Healthcheck» y «El compose reenvía las variables de configuración documentadas»; 7 ADDED). Sin migraciones ni cambios de esquema.
- Comportamiento visible: la primera request tras ≥ 4 min sin uso tarda 1–3 s más (la base despierta); `/health` suma el campo `db_pool`.
