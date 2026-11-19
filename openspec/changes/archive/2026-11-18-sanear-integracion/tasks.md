# Tasks — Sanear la integración

> Entorno del coder: worktree propio (rama `feature/`), Postgres propio. Tests SIEMPRE con
> `MODEL_CACHE_DIR=C:/Users/jastorga/.model-cache/<dir> bash ../bun-test-locked.sh <puerto_pg_propio> <archivos>`
> (puertos fijos 13091-13093: dos suites a la vez se pisan). Nunca 5433, Neon ni el contenedor `cortex`.
> Prohibido `prisma migrate dev` (borra el HNSW y el índice parcial: este change no toca migraciones ni
> `prisma/schema.prisma`) y cualquier formateador: el repo usa comillas simples y sin punto y coma.
> Una tarea es `[x]` solo con la salida del comando que la prueba.

## 1. Código

- [x] 1.1 `src/tools/mcp-server.ts`: en el handler de `cortex_apps` (líneas 391-402) reemplazar
  `JSON.stringify({...}, null, 2)` por `respuestaJson({...})` (ya importada en la línea 31). No cambiar el
  contenido de la respuesta, solo la serialización.
- [x] 1.2 `docker-compose.yml`, servicio `server`, `environment` (línea 27 en adelante): agregar
  `CORTEX_STRICT_NOTES: ${CORTEX_STRICT_NOTES:-}` y `MCP_SESSION_TTL_MINUTES: ${MCP_SESSION_TTL_MINUTES:-1440}`.
  El defecto del TTL NO puede ser vacío: `parseSessionTtlMinutes('')` escribe un aviso en cada arranque.
- [x] 1.3 Filtro `app` en blanco: cambiar la condición por `filter.app?.trim()` en `src/db/notes.ts:566`
  (`buildListFilter`), `src/db/notes.ts:734` (`lexicalSearch`) y `src/db/search.ts:84` (`hybridSearch`).
  El valor que se pasa a `appFilterValues` sigue siendo `filter.app` (la normalización vive en
  `src/db/apps.ts`; no duplicarla).
- [x] 1.4 Modo estricto frente a `force` (decisión D1, opción 1): en `src/db/notes.ts:219-226` el mensaje
  del `ValidationError` por bitácora agrega la frase `force no evita este rechazo`; en
  `src/tools/mcp-server.ts:139` (descripción de `cortex_write`) agregar que con `CORTEX_STRICT_NOTES` activo
  una bitácora se rechaza y `force` no lo anula. No mover el orden de `validateCreate`: `force`+`reason`
  se sigue validando antes que el modo estricto. NO hacer que `force` salte el modo estricto: ver design D1.
- [x] 1.5 Gate: `bun run typecheck` sin errores y `bash ../bun-test-locked.sh <puerto> test/mcp.test.ts
  test/apps.test.ts test/notes.test.ts` en verde.

## 2. Documentación y specs vigentes

- [x] 2.1 `README.md`: el ejemplo de `/health` (línea 124) muestra los cinco campos reales
  (`status`, `notes`, `model_loaded`, `sessions`, `uptime_s`); documentar que `force` no anula
  `CORTEX_STRICT_NOTES` ni `CORTEX_APP_MODE=strict` (junto a la línea 64) y que el importador queda sujeto
  a ambos modos: para importar notas con títulos fechados hay que desactivar `CORTEX_STRICT_NOTES` durante la
  importación (decisión D1 de Juan, 2026-11-18).
- [x] 2.2 `CONTRIBUTING.md`: mismo ejemplo de `/health` (línea 54); corregir las referencias
  `src/db/notes.ts:273`, `:282` y `:290` (líneas 91, 94 y 97) a `:480`, `:487` y `:494`; agregar a la lista
  de variables (línea 21) `CORTEX_STRICT_NOTES`, `CORTEX_APPS`, `CORTEX_APP_ALIASES` y `CORTEX_APP_MODE`.
- [x] 2.3 `skills/cortex-mcp-project/SKILL.md`: quitar «Las tools usan `q`, no `query`» (línea 151: desde #21
  `query` es alias válido) y cambiar «66 tests (baseline ago-2026)» (línea 136) por el conteo vigente
  de `bun test` en el momento de la entrega.
- [x] 2.3b `skills/cortex-mcp/SKILL.md`: agregar en «Deduplicado» o «La nota» que `cortex_write` y
  `cortex_update` devuelven `warnings` (bitácora o forma que no calza con el `kind`) y que no bloquean salvo
  `CORTEX_STRICT_NOTES`.
- [x] 2.4 Purpose obsoleto: DESPUÉS de archivar este change, editar `openspec/specs/servidor-mcp/spec.md`
  línea 4 («siete tools MCP» → «ocho tools MCP»). Los main specs NO se editan a mano antes del archive (rompe
  el match de MODIFIED/REMOVED); el resto del spec se sincroniza solo con los deltas de este change.
- [x] 2.5 Comentarios de encabezado de test que quedaron rancios: `test/mcp.test.ts:5` («seis tools» → ocho) y
  `test/mcp-sessions.test.ts:7` («7 tools» → 8). Solo comentarios.

## 3. Tests nuevos

- [x] 3.1 `test/paginacion.test.ts` (`describe('Las respuestas JSON de las tools son compactas'`, línea 678): agregar `cortex_apps` a la lista de
  tools comprobadas con `expect(text).toBe(JSON.stringify(JSON.parse(text)))`.
- [x] 3.2 `test/compose.test.ts` (archivo nuevo): leer `docker-compose.yml` con el paquete `yaml` (ya es
  dependencia) y comprobar que `services.server.environment` contiene `CORTEX_DUPLICATE_THRESHOLD`,
  `CORTEX_APPS`, `CORTEX_APP_ALIASES`, `CORTEX_APP_MODE`, `CORTEX_STRICT_NOTES` y `MCP_SESSION_TTL_MINUTES`,
  y que el valor de esta última es `${MCP_SESSION_TTL_MINUTES:-1440}`. No ejecutar `docker` en el test.
- [x] 3.3 `test/mcp.test.ts`: con `process.env.CORTEX_STRICT_NOTES = '1'` (restaurar en `finally`), `cortex_write`
  de título `Cierre SEC-2: MR !44 mergeado` con `force: true` y `reason` responde `isError: true`, el texto contiene
  `title` y `force`, y el conteo de `cortex_list` no cambia; con `CORTEX_APP_MODE=strict` y
  `CORTEX_APPS=backend,general`, `app: "sistema-nuevo"` con `force` responde `isError: true` sobre `app`.
  Verificar que el test deja el entorno como lo encontró (los tests de `test/note-quality.test.ts` borran la variable).
- [x] 3.4 `test/apps.test.ts` y `test/api.test.ts`: (a) `listNotesPage`/`cortex_list` con `app: "   "` devuelve el
  mismo `total` que sin el parámetro; (b) `GET /api/search?q=...&app=%20%20%20` devuelve lo mismo que sin `app`;
  (c) `cortex_list` por MCP con `app` y `include_general: false` solo trae la app pedida (hoy solo lo prueba la
  capa de datos); (d) `GET /api/apps` responde `apps` con conteos y `vocabulary` con `canonicas`, `modo` y
  `aliases`, y `GET /api/search?...&include_general=false` excluye `general`; (e) `cortex_apps` por MCP con una
  nota borrada no la cuenta. Hoy ninguno de estos escenarios del spec tiene un test.
- [x] 3.5 `test/alias-argumentos.test.ts:101`: reemplazar `if (issueProp) {...}` por una aserción
  `expect(issueProp).toBeDefined()` antes de comprobar los tipos: hoy, si `cortex_write` dejara de declarar
  `issue`, el test pasa sin comprobar nada.
- [x] 3.6 Gate: `bash ../bun-test-locked.sh <puerto> test/paginacion.test.ts test/compose.test.ts test/mcp.test.ts
  test/apps.test.ts test/api.test.ts test/alias-argumentos.test.ts` en verde.

## 4. Sabotaje (el coder rompe cada arreglo y comprueba que su test se pone rojo; luego revierte)

- [x] 4.1 Volver a `JSON.stringify(..., null, 2)` en `cortex_apps` → 3.1 en rojo. Pegar la línea `(fail)`.
- [x] 4.2 Quitar `MCP_SESSION_TTL_MINUTES` del compose → 3.2 en rojo; cambiar su defecto a vacío → 3.2 en rojo.
- [x] 4.3 Quitar el `?.trim()` de CADA uno de los tres lugares de 1.3, uno por vez → el test de 3.4 que cubre ese
  camino (listado, búsqueda, REST) en rojo.
- [x] 4.4 Invertir el orden en `validateCreate` para que `force` salte el modo estricto → 3.3 en rojo.
- [x] 4.5 Quitar la frase `force no evita este rechazo` y la mención en la descripción de `cortex_write` → el
  test que lee ambos textos (agregarlo en 3.3 si falta) en rojo.
- [x] 4.6 `git diff` posterior a revertir cada sabotaje: sin restos de la mutación.

## 5. QA contra servidor real (card `qa`, sin navegador: cliente MCP del SDK + curl)

- [ ] 5.1 Servidor en un puerto propio con base propia: `cortex_apps` compacto (`texto === JSON.stringify(JSON.parse(texto))`)
  y `GET /api/apps` con el mismo contenido.
- [ ] 5.2 `CORTEX_STRICT_NOTES=1`: bitácora con `force` + `reason` rechazada con el texto nuevo; nota de conocimiento creada.
- [ ] 5.3 `cortex_list` y `cortex_search` con `app: "   "`: mismo `total`/resultados que sin `app`.
- [ ] 5.4 `docker compose -f docker-compose.yml config` con `CORTEX_STRICT_NOTES=1` y `MCP_SESSION_TTL_MINUTES=5`:
  ambas en el `environment` del servicio `server`; sin la segunda, vale `1440`.
- [ ] 5.5 Procesos: PID y puerto de cada servidor levantado, y puerto libre al terminar (verificar con `netstat`).

## 6. Cierre (suite completa solo aquí)

- [x] 6.1 `bun run typecheck` sin errores.
- [x] 6.2 Suite completa: `bash ../bun-test-locked.sh <puerto_pg_propio>` → 0 fail (baseline de main: 319 pass / 0 fail;
  este change suma tests, el conteo debe ser mayor).
- [x] 6.3 `openspec validate sanear-integracion --strict` limpio; `openspec archive sanear-integracion --yes`;
  `openspec validate --specs --strict` limpio; tarea 2.4 (Purpose).
- [x] 6.4 `grep -rn "siete" openspec/specs/ README.md CONTRIBUTING.md skills/` sin coincidencias sobre tools.
