# Tasks — resiliencia del servidor (GitHub #16)

> Comandos del repo: `TEST_DATABASE_URL=postgresql://cortex:cortex_dev@127.0.0.1:5442 bun test` y `bun run typecheck` (puerto 5442 = contenedor `cortex-test-gh-16`; nunca el 5433, nunca la BD de Neon, nunca el contenedor `cortex` de :3091). Línea base de esta rama: 73 pass / 0 fail, typecheck limpio. Trabajar solo en el worktree `.worktrees/gh-16` (rama `feat/resiliencia`); nunca en `develop`/`main`.
> Los grupos 1–6 son del coder; correr durante el desarrollo solo el archivo de test del grupo (`bun test test/<archivo>`). La suite completa va únicamente en el grupo 7. El grupo 8 es de QA.
> No tocar el cuerpo de los handlers de las tools (`src/tools/mcp-server.ts:44-392`): #10 y #13+#14 editan esa zona y los tres PRs chocarían.
> «Sabotaje» = romper a propósito la implementación, ver el test en rojo, restaurar y ver el verde; se anota en el comentario de la card con el comando y la salida.

## 1. Reintento ante fallos de conexión (`src/db/retry.ts`, `src/db/client.ts`)

- [x] 1.1 Crear `src/db/retry.ts` con `DbUnavailableError` (mensaje fijo `Base de datos no disponible; reintentá en unos segundos`, `cause` = error original), `isConnectionNotExecuted(err)` (`instanceof Prisma.PrismaClientInitializationError`, o `PrismaClientKnownRequestError` con `code` P1001, P1002 o P2024), `isConnectionDropped(err)` (código P1017) y `withDbRetry(fn, { idempotent, sleep, now })` con esperas 200/500/1000 ms y tope de 8 s desde el primer intento (design D1).
- [x] 1.2 En el mismo archivo, `retryingClient(client)`: `Proxy` que envuelve con `withDbRetry` los métodos de los delegados de modelo y `$queryRaw`, `$queryRawUnsafe`, `$executeRaw`, `$executeRawUnsafe`, `$transaction`; `idempotent: true` solo para `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`, `groupBy`, `$queryRaw`, `$queryRawUnsafe`. No envolver `$connect`, `$disconnect`, `$on`, `$extends`. Al agotar, loguear el error original con `console.error` y lanzar `DbUnavailableError`.
- [x] 1.3 `src/db/client.ts`: exportar `rawPrisma = new PrismaClient()` y `prisma = retryingClient(rawPrisma) as PrismaClient`. No cambiar las importaciones de `src/db/notes.ts` ni `src/db/search.ts` (reciben el cliente por parámetro).
- [x] 1.4 `test/retry.test.ts` (sin BD real, con cliente falso y `sleep` inyectado). Un test por scenario de los requirements «Reintento ante fallos de conexión con la BD», «Las escrituras solo reintentan si no pudieron aplicarse» y «Mensaje al agente cuando la BD no está disponible»: lectura con P1001→éxito = 2 intentos; `NotFoundError`/`ValidationError`/`ConflictError`/P2002 = 1 intento; 4 fallos P1001 = 4 intentos y `DbUnavailableError`; lectura P1017→éxito = 2 intentos; escritura P1017 = 1 intento; escritura con `PrismaClientInitializationError`→éxito = 1 efecto; mensaje sin `db.ejemplo.interno` ni `5432`; con tiempo simulado > 8 s no se inicia el intento siguiente. Construir los errores con `new Prisma.PrismaClientKnownRequestError(msg, { code, clientVersion })` y `new Prisma.PrismaClientInitializationError(msg, clientVersion)`.
- [x] 1.5 Test de integración en el mismo archivo contra la BD de test (5442): `retryingClient(new PrismaClient())` ejecuta `$queryRaw`, `note.count()` y `$transaction(async tx => tx.note.count())` y devuelve los mismos valores que el cliente sin envolver.
- [x] 1.6 Sabotaje: (a) quitar el `instanceof PrismaClientInitializationError` de `isConnectionNotExecuted` → debe fallar el test de escritura con error de inicialización; (b) marcar `$transaction` como `idempotent: true` → debe fallar «escritura P1017 = 1 intento». Anotar ambos.

## 2. `/health` (`src/health.ts`, `src/index.ts`)

- [x] 2.1 Crear `src/health.ts` con `createHealthProbe({ countNotes, timeoutMs = 3000, staleMs = 30000, now })` según design D2: `Promise.race` con timeout de 3 s, sondeo único compartido, sondeo > 30 s descartado. Devuelve `{ ok: true, notes } | { ok: false }`; `index.ts` arma el body (200 `{status:"ok", notes, model_loaded, sessions, uptime_s}` o 503 `{status:"degraded", db:"down", model_loaded, sessions, uptime_s, error:"base de datos no disponible"}`); el mensaje real del fallo va a `console.error`, no al body.
- [x] 2.2 `src/index.ts:17-20`: la ruta `/health` usa el sondeo, fija `set.status` y agrega `sessions` (`getActiveSessions()`) y `uptime_s` (`Math.floor(process.uptime())`). `createApp(opts?: { countNotes?: () => Promise<number> })`; sin argumento usa `rawPrisma.note.count({ where: { deleted_at: null } })`. No tocar el bloque `/api/search` (`:24-39`): es de #13+#14.
- [x] 2.3 `test/health.test.ts`: con `countNotes` falso que rechaza → 503 con `db:"down"` y body sin el host de la excepción; con `countNotes` que no resuelve → 503 en < 5 s (medir con `performance.now()`); 20 requests simultáneas con `countNotes` colgado → `countNotes` llamado 1 vez; con reloj inyectado, sondeo pendiente 31 s → llamada nueva; con `countNotes` que luego resuelve → 200 en la request siguiente.
- [x] 2.4 `test/api.test.ts:70-83`: agregar a la aserción existente `sessions` y `uptime_s` numéricos; no cambiar las demás.
- [x] 2.5 Sabotaje: quitar el `Promise.race` → el test «no resuelve» debe colgarse/fallar por timeout; quitar el sondeo compartido → debe fallar «20 requests = 1 llamada».

## 3. Sesiones MCP (`src/tools/sessions.ts`, `src/tools/mcp-server.ts`, `src/index.ts`)

- [x] 3.1 Crear `src/tools/sessions.ts` con `SessionRegistry` (design D3) y `parseSessionTtlMinutes(raw)`: `undefined` → 1440; no numérico o < 1 → 1440 y `console.warn` con el valor recibido. Cada alta y baja escribe `[cortex] sesión creada <id8> (activas: N)` / `[cortex] sesión cerrada <id8> motivo=<delete|ttl|shutdown> (activas: N)`.
- [x] 3.2 `src/tools/mcp-server.ts`: reemplazar el `Map` suelto (`:32`) y `getActiveSessions` (`:494`) por el registro; en `createSession` (`:396-417`) `onsessioninitialized` → `registry.add`, `onsessionclosed` → `registry.delete(sid,'delete')`; en `handleMcpRequest` (`:431-440`) usar `registry.get(sessionId)` (renueva `lastSeen`) y para sesión desconocida devolver 404 con cuerpo `{jsonrpc:"2.0", error:{code:-32001, message:"Session not found"}, id:null}` y `Content-Type: application/json`. Exportar `closeAllSessions(motivo)` y `sweepIdleSessions()`. No editar nada entre `:44` y `:392`.
- [x] 3.3 `src/index.ts` (bloque `import.meta.main`): arrancar `setInterval(sweepIdleSessions, 60_000)` con `.unref()` usando `parseSessionTtlMinutes(process.env.MCP_SESSION_TTL_MINUTES)`.
- [x] 3.4 `test/sessions.test.ts` (unitario, transports falsos con `close()` espiado y reloj inyectado): los 4 scenarios de «Expiración de sesiones MCP inactivas» (TTL+1 ms se elimina y `close()` llamado; TTL−1 min permanece; request con el id renueva; `MCP_SESSION_TTL_MINUTES` = `abc`, `0` y `-5` → 1440 con aviso) y el scenario de «Alta y baja… en el log» (capturar `console.log`; verificar `sesión creada` y `sesión cerrada motivo=delete` con los 8 primeros caracteres).
- [x] 3.5 `test/mcp-sessions.test.ts` (integración, patrón de `test/mcp.test.ts`: `createApp()` en puerto propio `13192`, `fetch` directo con cabeceras `Content-Type: application/json` y `Accept: application/json, text/event-stream` (sin `Accept` el SDK responde 406; flujo crudo verificado: `initialize` → 200 con `mcp-session-id`, `tools/list` con ese id sin `notifications/initialized` → 200 con 7 tools)): `tools/list` con un `mcp-session-id` inventado → 404 con `error.code === -32001` e `id === null`; luego `initialize` sin id → 200 con `mcp-session-id` nuevo y `tools/list` con ese id lista las 7 tools (scenarios «Sesión desconocida responde 404 JSON-RPC»).
- [x] 3.6 Sabotaje: quitar la renovación de `lastSeen` en `get` → debe fallar «la actividad renueva el TTL»; devolver el cuerpo viejo `{error: …}` → debe fallar el 404 JSON-RPC.

## 4. Cierre limpio (`src/shutdown.ts`, `src/index.ts`)

- [x] 4.1 Crear `src/shutdown.ts` con `createShutdown(...)` según design D4.
- [x] 4.2 `src/index.ts` (bloque `import.meta.main`): guardar el retorno de `app.listen`, construir el handler con `closeSessions: closeAllSessions`, `stopServer: () => app.stop()`, `disconnect: () => rawPrisma.$disconnect()`; registrar `process.on('SIGTERM')`, `process.on('SIGINT')`, y `uncaughtException`/`unhandledRejection` (loguear `err.stack` y cerrar con código final 1).
- [x] 4.3 `test/shutdown.test.ts` (stubs, `exit` espiado): orden log → closeSessions → stopServer → disconnect → exit(0); `stopServer` que no termina en 8 s (reloj inyectado) → `exit(1)` y `disconnect` igualmente intentado; segunda llamada → `exit(1)` inmediato sin repetir pasos; `disconnect` que rechaza → exit(1) y log del error.
- [x] 4.4 Test de integración en el mismo archivo con la app real (`createApp()` en puerto `13193`): una request lenta en curso (`GET /health` con un `countNotes` inyectado que tarda 1,5 s; no agregar rutas de prueba al producto) termina con 200 después de llamar al handler de cierre, y el `fetch` nuevo posterior es rechazado. Verifica la hipótesis de design D4 sobre `app.stop()`; si falla, usar `app.stop()` + espera propia de requests en curso y anotarlo en `friccion`.
- [x] 4.5 Sabotaje: invertir el orden (`disconnect` antes de `closeSessions`) → debe fallar el test de orden; quitar el tope de 8 s → debe fallar «cierre que no termina».

## 5. Documentación

- [x] 5.1 `README.md`: nueva sección «Si el contenedor aparece `unhealthy`» (antes de `## Licencia`, `README.md:169`) con los cuatro puntos del requirement «El README explica qué pasa con un contenedor unhealthy» y el texto de `/health` 503. No editar otras secciones (#13+#14 y #10 pueden editar la tabla de tools y «Qué guarda»).
- [x] 5.2 `CONTRIBUTING.md` (párrafo «Variables:» de «Desarrollo local»): agregar `MCP_SESSION_TTL_MINUTES` (opcional, defecto 1440). Y en «Arquitectura y concurrencia», una línea sobre reintentos y que `/health` no reintenta.
- [x] 5.3 `.env.example`: agregar `# MCP_SESSION_TTL_MINUTES=1440` comentado.

## 6. Verificación del change

- [x] 6.1 `openspec validate resiliencia-servidor --type change --strict` sin errores ni warnings.
- [x] 6.2 `grep -n "new Map" src/tools/mcp-server.ts` sin resultados (el registro vive en `src/tools/sessions.ts`).
- [x] 6.3 `git diff --stat origin/main -- src/tools/mcp-server.ts` no toca líneas dentro de las tools (`registerTools`, hoy `:44-392`): verificar con `git diff -U0 origin/main -- src/tools/mcp-server.ts` que ningún hunk cae en ese rango.

## 7. Suite completa (solo aquí)

- [x] 7.1 `TEST_DATABASE_URL=postgresql://cortex:cortex_dev@127.0.0.1:5442 bun test` → 73 previos + nuevos, 0 fail.
- [x] 7.2 `bun run typecheck` limpio.

## 8. Verificación de QA (sin browser: curl, cliente MCP y Docker)

> Autorizado por el usuario (2026-11-17): `cortex-test-gh-16` (5442) para pause/unpause/stop/start/restart, y el contenedor efímero `cortex-qa-gh-16` (:3192) con `docker build`. Nunca `cortex` (:3091), nunca otro contenedor. Server de QA levantado desde el worktree: `PORT=3192 DATABASE_URL=postgresql://cortex:cortex_dev@127.0.0.1:5442/cortex_test bun run src/index.ts` (script a archivo, PID anotado, apagado al terminar). Cada caso anota comando, salida y tiempo medido.

- [x] 8.1 Sano: `curl -s -w '%{http_code}' http://localhost:3192/health` → 200 con `status`, `notes`, `model_loaded`, `sessions`, `uptime_s`.
- [x] 8.2 BD pausada (`docker pause cortex-test-gh-16`): primero una consulta que caliente el pool (`curl /health` sano), pausar, `curl -m 6 -w '%{http_code} %{time_total}'` → 503 en < 5 s, `db:"down"`, body sin `127.0.0.1` ni `5442`. Repetir con el server recién arrancado (conexión fría). `docker unpause` → `curl /health` → 200 en ≤ 40 s sin reiniciar el server.
- [x] 8.3 Pool no agotado: con la BD pausada, 30 `curl /health` simultáneos; `docker unpause`; una llamada `cortex_list` por cliente MCP responde sin error de pool.
- [x] 8.4 Corte real (`docker stop`/`start` de `cortex-test-gh-16`, autorizado): con la BD detenida, `cortex_read` por cliente MCP responde `Error en cortex_read: Base de datos no disponible…` en ≤ 30 s; `docker start`, esperar `pg_isready` y repetir → éxito sin reiniciar el server. Anotar el tiempo que tarda Postgres en volver y cuántos intentos usó una llamada lanzada justo al arrancar (`docker restart` + llamada inmediata).
- [x] 8.5 Sesiones: abrir sesión con `initialize`, matar y relanzar el server (mismo puerto), `tools/list` con el id viejo → 404 con `error.code` -32001; `initialize` nuevo → 200. Con `MCP_SESSION_TTL_MINUTES=1`: crear sesión, esperar 125 s, `tools/list` con su id → 404 y el log trae `sesión cerrada motivo=ttl`.
- [x] 8.6 Señal real (contenedor efímero `cortex-qa-gh-16`, autorizado; antes apagar el server de QA del host, que usa el mismo puerto 3192): `docker build -t cortex-qa-gh-16 .` en el worktree; `docker run -d --name cortex-qa-gh-16 -p 3192:3091 -e DATABASE_URL=postgresql://cortex:cortex_dev@host.docker.internal:5442/cortex_test -v cortex-qa-gh-16-model:/app/.model-cache cortex-qa-gh-16` (la primera vez descarga ~420 MB); con una sesión MCP abierta, anotar antes las conexiones a la base (`docker exec cortex-test-gh-16 psql -U cortex -d postgres -tc "select count(*) from pg_stat_activity where datname='cortex_test'"`); `time docker stop cortex-qa-gh-16` < 10 s, esa cuenta vuelve de inmediato al valor previo al arranque del server (sin conexiones colgadas), `docker inspect -f '{{.State.ExitCode}}'` = 0 (con SIGKILL sería 137), `docker logs` con la línea de cierre y `sesión cerrada motivo=shutdown`. Al terminar `docker rm` del contenedor y del volumen.
- [ ] 8.7 Errores no capturados: no se prueba por curl; queda cubierto por el test del grupo 4 (declarar `OMITIDO` en QA con ese motivo).
