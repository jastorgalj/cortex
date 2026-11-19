# Proposal — Sanear la integración de main tras los 7 PRs del 18-nov

## Why

Siete PRs (#18–#24) entraron a `main` el mismo día, dos fuera de la fábrica (#22, #23) y varios en
paralelo. La auditoría (`auditoria.md`, raíz del worktree, no se commitea) cruzó specs, código y un
servidor real. La suite pasa (319/0 dos veces seguidas), pero encontró contradicciones que la suite no
ve porque ningún test las cubre:

- Los specs dicen «exactamente siete tools» y `serverInfo.version` `0.2.0`; el servidor expone ocho
  tools y anuncia `0.3.1` (`src/tools/mcp-server.ts:34-36`). Dos requirements vigentes se contradicen
  («Siete tools…» y «`cortex_apps` expone…»).
- `cortex_apps` responde JSON indentado (`src/tools/mcp-server.ts:391-402`): viola «Las respuestas JSON de
  las tools son compactas» y el test de compactación (`test/paginacion.test.ts`) no lo incluye.
- `docker-compose.yml` no reenvía `CORTEX_STRICT_NOTES` ni `MCP_SESSION_TTL_MINUTES`, que `.env.example`
  documenta «con default en el compose». En el flujo `docker compose up` no tienen efecto.
- Con `CORTEX_STRICT_NOTES=1`, `force: true` + `reason` no salta el rechazo de bitácora (medido), pero ningún
  spec ni texto lo dice y la descripción de `cortex_write` manda a usar `force` «para crear igualmente».
  El importador (que usa `force: true` por diseño) también queda rechazado por ambos modos estrictos.
- Un filtro `app` de solo espacios devuelve solo las notas de `general` en vez de no filtrar.

## What Changes

- Specs: reemplazar «Siete tools…» por «Ocho tools…»; versión del servidor = `package.json`; el
  requirement de compactación incluye `cortex_apps`; escenario de «Listado de reglas de una app»
  precisa «ninguna nota de `general`»; el requirement de API REST nombra `include_general` y
  `/api/apps`; requirement nuevo «Una app en blanco no filtra»; requirement nuevo «Los modos estrictos
  no se saltan con force» (sujeto a la decisión D1); requirement nuevo «El compose reenvía las variables
  de configuración documentadas».
- Código (grupo coder): `cortex_apps` serializa con `respuestaJson`; `docker-compose.yml` reenvía las dos
  variables; el filtro `app` en blanco no filtra; el mensaje y la descripción de `cortex_write` dicen
  que `force` no anula el modo estricto.
- Documentación y tests: README, CONTRIBUTING, skills y comentarios de test coherentes con el código;
  tests nuevos que cubren lo que hoy nadie prueba (ver `tasks.md`).
- Ya hecho en esta auditoría (artefacto de spec, no código): archivados `2026-11-18-taxonomia-app`
  (sus 5 requirements ya estaban idénticos en `openspec/specs/`: «Specs already in sync») y
  `warnings-calidad-nota` (+1 requirement en `notas`); `openspec validate --specs --strict` limpio.

## Capabilities

### New Capabilities

Ninguna.

### Modified Capabilities

- `servidor-mcp`: ocho tools, versión desde `package.json`, compactación de `cortex_apps`, API REST
  completa, compose que reenvía variables.
- `busqueda`: filtro por app precisado y app en blanco.
- `notas`: modos estrictos frente a `force` y al importador.

## Fuera de alcance

- Cambiar qué gana entre estricto y `force` (decisión D1 de Juan, 2026-11-18: gana el estricto; este change
  lo especifica).
- Workflow de CI que corra la suite en cada PR (hoy `.github/workflows/` solo tiene `publish.yml`):
  issue aparte que abre el orquestador (decisión D3 de Juan, 2026-11-18).
- `lexicalSearch` (`src/db/notes.ts:729`) no se llama desde `src/` y solo la ejercita
  `test/notes.test.ts`: eliminarla o cablearla es otro change.
- Paginar `GET /` (`src/index.ts:125` carga todas las notas con cuerpo): no es una contradicción entre PRs.
