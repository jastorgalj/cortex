## Contexto verificado (datos que fijan el diseño)

Probado contra `cortex-test-gh-16` (`docker pause`/`unpause`) y errores forzados, Prisma 6.19.3:

| Situación | Resultado medido | Consecuencia |
|---|---|---|
| Conexión ya en el pool, BD pausada | la consulta no responde ni falla (12 s sin respuesta) | `/health` necesita timeout propio; no hay error que reintentar |
| Conexión nueva, BD pausada | `PrismaClientInitializationError` a los ~5 s | un intento fallido cuesta hasta 5 s por sí solo |
| Conexión nueva, puerto sin servidor | `PrismaClientInitializationError` a los ~2 s | idem, ~2 s |
| Pool agotado (`connection_limit=1&pool_timeout=2`) con BD pausada | `PrismaClientKnownRequestError` código `P2024` a los 2 s | forma real de P2024 |
| `PrismaClientInitializationError` | `errorCode` y `code` son `undefined` (claves: `clientVersion, errorCode, retryable, name`) | filtrar por «P1001/P1002» no los detecta; se reconocen por `instanceof` |
| BD reanudada | cliente con pool y cliente frío vuelven a responder solos | no hace falta reiniciar el proceso |

No medido: forma exacta de P1017 (exige detener Postgres) — se mide en QA 8.4 (stop/start de la BD de test autorizado por el usuario).

## D1 — Reintento en el cliente Prisma, no en cada tool

Todos los handlers de `src/tools/mcp-server.ts` capturan la excepción y devuelven `isError` (`:62`, `:86`, `:164`, `:241`, `:295`, `:319`, `:380`): un wrapper alrededor del handler nunca vería el error. En vez de tocar los siete handlers (zona donde #10 y #13+#14 editan), `src/db/client.ts` exporta dos clientes: `rawPrisma` (el `PrismaClient`) y `prisma` (un `Proxy` que envuelve cada llamada con `withDbRetry`). Spike verificado: un Proxy así respeta tagged templates (`$queryRaw\`…\``), `Prisma.sql`, delegados de modelo y `$transaction(async tx => …)` contra la BD de prueba. Dentro de la transacción `tx` es el cliente real: no se reintenta sentencia por sentencia, se reintenta la transacción entera (solo si falló antes de ejecutarse).

- Lecturas (reintentan además P1017): `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`, `groupBy`, `$queryRaw`, `$queryRawUnsafe`.
- Todo lo demás es escritura (conservador: lo no reconocido no reintenta P1017). No se envuelven `$connect`, `$disconnect`, `$on`, `$extends`.
- Clasificación: «no llegó a ejecutarse» = `instanceof Prisma.PrismaClientInitializationError` o `PrismaClientKnownRequestError` con `code` ∈ {P1001, P1002, P2024}; P1017 = `PrismaClientKnownRequestError` con `code` P1017 (si en la práctica llega con otra clase, el coder lo registra en friccion y reconoce por `code` en cualquier clase de error de Prisma).
- Presupuesto: esperas 200/500/1000 ms; no se inicia un intento nuevo si pasaron > 8 s desde el primero (cada intento fallido ya cuesta 2–5 s; sin tope una tool colgaría 20 s).
- Al agotar: se lanza `DbUnavailableError` con mensaje `Base de datos no disponible; reintentá en unos segundos`. Los handlers imprimen `Error en cortex_<tool>: ${err.message}` (rama genérica de cada catch), así que el texto llega al agente sin tocar los handlers. El error original queda en `cause` y en el log (`console.error`), nunca en el mensaje.
- Los tests inyectan `sleep` y un cliente falso; sin reloj real.

## D2 — `/health` con timeout propio y sondeo único

`src/health.ts` exporta `createHealthProbe({ countNotes, timeoutMs = 3000, staleMs = 30000, now })`. `countNotes` usa `rawPrisma` (sin reintentos: `/health` debe contestar rápido). Cada request hace `Promise.race([probe, timeout 3 s])`. El sondeo en curso se guarda en una variable de módulo y las requests concurrentes lo comparten; si lleva > `staleMs` se descarta y se crea otro. Sin esto, cada request con la BD colgada deja una consulta colgada y se agota el pool (default de Prisma: nº de CPU × 2 + 1) antes de que vuelva la BD. Sigue contando notas (`prisma.note.count`, el campo `notes` ya existe) en vez de `SELECT 1`: es una consulta, prueba que el esquema está aplicado y evita cambiar el contrato. El cuerpo 503 lleva `error: "base de datos no disponible"` fijo; el mensaje real va a `console.error` (trae host y puerto).
`createApp` recibe `opts?: { countNotes?: () => Promise<number> }` para poder probar el 503 sin tumbar la BD; sin argumento usa `rawPrisma`.

## D3 — Registro de sesiones aparte

`src/tools/sessions.ts`: clase `SessionRegistry` con `add(id, transport)`, `get(id)` (renueva `lastSeen`), `delete(id, motivo)`, `sweep(nowMs, ttlMs)`, `closeAll(motivo)` y `size`. `mcp-server.ts` deja de tener el `Map` suelto (`:32`) y `getActiveSessions` (`:494`) delega en el registro. El barrido lo arranca `index.ts` en el bloque `import.meta.main` (`setInterval` 60 s con `.unref()`), no al importar el módulo: los tests importan `createApp` y un timer a nivel de módulo quedaría vivo entre archivos de test. TTL por `MCP_SESSION_TTL_MINUTES` (defecto 1440), leído una vez al arrancar.
`get` solo renueva cuando la request llega con el id; un stream GET abierto no cuenta como actividad continua (limitación aceptada, ver riesgos de la propuesta).
404 de sesión desconocida: hoy el cuerpo es `{error: "Sesión '…' no encontrada…"}` (`mcp-server.ts:434-437`, verificado en vivo), no JSON-RPC. Se cambia al formato de `createJsonErrorResponse` del SDK (`webStandardStreamableHttp.js:120-135`): `{jsonrpc:"2.0", error:{code:-32001, message}, id:null}`. Verificado en `node_modules`: `client/streamableHttp.js` del SDK 1.32.2 no tiene manejo de 404 (todo no-OK lanza `StreamableHTTPError`, `:326-378`), y el cliente Python `mcp` 2.3.0 de la caché de Hermes convierte el 404 en el error «Session terminated» sin reinicializar. No verificado: qué hace el cliente de Hermes en producción. Por eso el cambio de servidor es acotado al formato; que el cliente reinicialice solo depende de él.

## D4 — Cierre

`src/shutdown.ts`: `createShutdown({ closeSessions, stopServer, disconnect, log, exit, graceMs = 8000 })` devuelve el handler `(motivo) => Promise<void>`. Orden: log → `closeSessions('shutdown')` (cierra también los streams SSE; sin esto `stop()` esperaría conexiones abiertas) → `stopServer()` (`app.stop()` sin `true`: no corta requests en curso) con tope de `graceMs` → `disconnect()` (`rawPrisma.$disconnect()`) → `exit(0)`. Si se pasa de `graceMs`: log + `exit(1)`. Segunda llamada: `exit(1)` inmediato. `index.ts` lo registra con `process.on('SIGTERM'|'SIGINT')` y, para `uncaughtException`/`unhandledRejection`, loguea el stack y llama al mismo handler con código final 1.
Hipótesis sin verificar: que `app.stop()` sin `true` deje terminar las requests en curso en Bun 1.4.2 (lo dice el JSDoc de Elysia, `stop(true)` = «abruptly»); el test de cierre con request lenta lo comprueba.
Windows: las señales no se pueden entregar a un proceso Bun (`kill` termina a la fuerza). Los tests unitarios ejercen `createShutdown` directo; la señal real se verifica en un contenedor Linux (QA, grupo 8).

## D5 — Compose

Sin cambios en `docker-compose.yml` ni `Dockerfile`: el healthcheck ya exige `r.ok && j.status === "ok"` (`docker-compose.yml:38`, `Dockerfile:91`), y un 503 `degraded` lo marca unhealthy igual que el 500 de hoy. No se agrega `autoheal` ni `restart: always` (este último tampoco reinicia contenedores unhealthy): solo se documenta.
