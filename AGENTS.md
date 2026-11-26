# Cortex — instrucciones para agentes

## Stack

Bun + TypeScript + Elysia + Postgres (pgvector). Specs en `openspec/` dentro del mismo repo.

## Compuertas (en este orden)

```bash
bun run typecheck          # tsc --noEmit
bun test                   # requiere Postgres local (ver abajo)
```

No hay linter configurado. No hay `npm`; todo es `bun`.

## Tests y Postgres

Los tests usan **siempre** una BD local `cortex_test` creada por `test/preload.ts`.
El preload se conecta a `127.0.0.1:5433` (el puerto del `docker-compose.yml`).

- Si el compose del usuario ya corre (`docker ps --filter name=cortex`), los tests usan ese Postgres.
- Para un **worktree aislado**, levantar un contenedor dedicado en un puerto libre (≥13095)
  y pasar `TEST_DATABASE_URL=postgresql://cortex:cortex_dev@127.0.0.1:<puerto>` al correr los tests.
- **Nunca** tocar el compose del usuario (puerto 5433) ni su BD de desarrollo.

### Puertos reservados por los tests HTTP

| Puerto | Archivo |
|--------|---------|
| 13091  | `test/mcp.test.ts` |
| 13092  | `test/api.test.ts` |
| 13093  | `test/delete.test.ts` |
| 13094  | `test/alias-argumentos.test.ts`, `test/paginacion.test.ts` |

No usar estos puertos para Postgres de test; usar ≥13095.

### Baseline (v0.5.0, main 3bf9c6f)

- `bun run typecheck`: 0 errores
- `bun test` (con Postgres en 5433): **334 pass / 0 fail** (esperado)
- 3 tests de `test/health.test.ts` (shutdown/idle) son lentos (~5s cada uno): preexistentes, no son fallos.

## Búsquedas en código

Usar **Trail** (`trail_find_code`, `trail_find_all`) con `in=cortex/` para búsquedas.
Consultar **Cortex** (`cortex_search` app=cortex) antes de proponer cambios.

## Git

- Base branch: `main` (no hay `develop`).
- Ramas de feature: `feat/<slug>`.
- Ramas de spec: van en el mismo repo y PR.
- CI: no configurado aún (issue #26 pendiente).

## Docker Compose (usuario)

```
db:     pgvector/pg16, puerto 5433 (NO tocar)
server: cortex, puerto 3091
```
