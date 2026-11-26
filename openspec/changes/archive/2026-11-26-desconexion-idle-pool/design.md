## Contexto verificado (datos que fijan el diseño)

Probado contra `cortex_test` en :5460 (PG local, nunca Neon), Prisma 6.19.3 sobre Bun, sonda fuera del repo:

| Situación | Resultado medido | Consecuencia |
|---|---|---|
| `new PrismaClient()` sin consultas | 0 conexiones | el pool NO se abre al construir el cliente (el body de la card dice `client.ts:5` abre el pool: es falso); se abre con la primera consulta, que en producción es el primer `/health` |
| Pool abierto y 420 s sin ninguna llamada | sigue 1 conexión | el `max_idle_connection_lifetime` de 300 s de Prisma 6 no la cierra sin actividad (documentado como reemplazo en el siguiente `check_out`): sin este cambio el pool queda abierto indefinidamente |
| `$disconnect()` | 1 → 0 conexiones en el servidor | cierra de verdad los sockets |
| Consulta después de `$disconnect()` | responde bien y abre 1 conexión nueva | reconexión perezosa confirmada, sin `$connect()` |
| `$disconnect()` con una consulta en vuelo (`pg_sleep(2)`) | `$disconnect` esperó 1,6 s y la consulta terminó OK | Prisma no corta lo que está corriendo (1 corrida) |
| Consulta lanzada a la vez que `$disconnect()` | terminó OK | sin carrera visible (1 corrida) |

No medido: el despertar real de Neon (prohibido tocar Neon; el DEV no lo reproduce) y si una conexión ociosa abierta impide por sí sola que Neon suspenda. La documentación de Neon dice que cada **conexión nueva o consulta** reinicia el temporizador de 5 min y que un cliente con conexión ociosa ve el error `terminating connection due to administrator command` cuando el compute ya suspendió, lo que sugiere que una conexión ociosa NO lo mantiene despierto. Es **hipótesis**: el sospechoso verificado en código es el sondeo de `/health` cada 30 s (D3).

## D1 — Módulo `src/db/idle-disconnect.ts`, temporizador único con generación

`createIdleDisconnect({ disconnect, minutes, setTimer, clearTimer, log })` devuelve `{ touch, isIdle, dispose }`. Un solo temporizador `setTimeout` (no `setInterval`), reprogramado en cada `touch()`; `touch` es una closure sin `this`, para pasarla como callback. Estado: `idle` (bool) y `generation` (entero que sube en cada `touch()`).

- Al vencer: `await disconnect()`; solo si `generation` no cambió mientras tanto, `idle = true`. Si hubo `touch()` durante el `$disconnect()`, el pool ya se está reconectando y declararlo inactivo haría que `/health` omitiera la consulta con el pool vivo.
- Si `disconnect()` rechaza: `log`, no se marca idle, se reprograma el plazo completo (no un bucle apretado).
- Arranca activo con el temporizador armado: el plazo cuenta desde el arranque. Alternativa descartada: arrancar en idle («aún no conectado»): el primer `/health` tras el arranque no consultaría la DB y los tests actuales de `createApp()` (que esperan `notes`) cambiarían de comportamiento.
- `minutes === 0`: no crea temporizador; `isIdle()` siempre `false`.
- Temporizador `unref()` y `dispose()` en el cierre: sin ellos `bun test` no termina y `$disconnect()` del temporizador compite con el del cierre.
- Reloj y temporizador inyectables, igual que `sleep`/`now` en `retry.ts`: los tests no esperan minutos.

## D2 — La actividad se registra en `withDbRetry`

`withDbRetry` llama `onActivity` al empezar y en `finally` (no entre reintentos). Es el único punto por el que pasan las tools MCP, `/api/*` y la vista web (`prisma` = `retryingClient(rawPrisma)`), así que no se toca ningún handler. `$disconnect` está en `SKIP_METHODS` (`src/db/retry.ts`) y no cuenta. Alternativa descartada: contador de operaciones en curso: las operaciones duran segundos y el plazo, minutos; además Prisma ya espera a las consultas en vuelo (tabla de arriba), así que el contador no añade garantía observable.

## D3 — `/health` omite la consulta con el pool inactivo; el sondeo NO cuenta como actividad

El body de la card afirma que el healthcheck de Docker «solo aplica en dev local con BD local»: es falso. `docker-compose.yml:24` toma `DATABASE_URL` del `.env` (spec «La URL de la base se pasa por entorno»: Neon hoy) y `docker-compose.yml:38-48` y `Dockerfile:43` consultan `/health` cada 30 s, que hace `count(*)` (`src/index.ts:25`). Con el servidor contra Neon eso es una consulta cada 30 s las 24 h: por sí solo impide que el compute suspenda, aunque el pool se cierre. Por eso el cambio exige las dos cosas: desconectar el pool y que `/health` no lo reabra.

- `/health` no usa `touch()`: `rawPrisma.note.count` no pasa por `retryingClient`. Si contara, el sondeo mantendría el pool vivo para siempre.
- Con `isPoolIdle()` verdadero responde 200 `{status:'ok', db_pool:'idle', model_loaded, sessions, uptime_s}` sin `notes` y sin llamar a `probe()`. El healthcheck de Docker solo lee `r.ok && j.status === 'ok'` (`docker-compose.yml:44`, `Dockerfile:44`): sigue pasando.
- Consecuencia aceptada por el pedido: en inactividad `/health` no detecta una base caída (con `plazo` de 4 min, una caída de más de 4 min sin tráfico pasa de 503 a 200 `idle`); la primera operación de usuario la detecta con `DbUnavailableError`. Documentado en el README (tasks 4.5).
- Con la DB caída y un `$disconnect()` que no termina, `isIdle()` nunca llega a `true` y `/health` sigue dando 503: es la salida segura. Si Prisma colgara `$disconnect()` con el peer muerto es **hipótesis** no medida (no hay timeout propio; no se añade: YAGNI hasta verlo).

## D4 — Cableado

`src/db/client.ts` exporta `idleDisconnect` junto a `rawPrisma` y `prisma`; `src/index.ts` lo usa por `AppOptions.isPoolIdle` (inyectable, para los tests de `/health`) y en el `disconnect` del cierre (`dispose()` antes de `rawPrisma.$disconnect()`). `src/shutdown.ts` no cambia: su contrato de pasos ya recibe `disconnect` por inyección. `src/import.ts` crea su propio `PrismaClient` (`:35`) y no se ve afectado.

## D5 — Tests con el plazo desactivado

`bunfig.toml [test.env] DB_IDLE_DISCONNECT_MINUTES = "0"`: `bun test` comparte un solo proceso y el módulo `client.ts`; el temporizador global de 4 min no debe poder disparar a mitad de la suite. Las pruebas del comportamiento crean su propia instancia con plazo inyectado (task 1.3) o con plazo real de ~120 ms (task 1.4). La instancia global y su cableado se prueban en el grupo 5 (servidor real en :13299 con `DB_IDLE_DISCONNECT_MINUTES=0.1`).

## D6 — Valor del plazo

Número ≥ 0, decimales permitidos. Ausente o vacío = 4 sin aviso (el compose pasa `${...:-4}`; `Number('')` vale 0 y desactivaría la función en silencio, por eso la cadena vacía se trata antes). `0` = desactivado. Inválido = 4 con aviso, igual que `parseSessionTtlMinutes` (`src/tools/sessions.ts:87`). El valor 4 no está atado a los 5 min de Neon: Neon suspende 5 min después de la última consulta o conexión, de modo que el compute se apaga unos 5 min después de la desconexión, no antes.
