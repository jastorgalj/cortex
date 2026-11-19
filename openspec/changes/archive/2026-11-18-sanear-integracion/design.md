# Design — Sanear la integración

## D1 — El estricto gana a `force` (decidido por Juan, 2026-11-18: opción 1)

`validateCreate` (`src/db/notes.ts:195-227`) evalúa `force`+`reason` (línea 214) y después el modo estricto
(líneas 219-226): `force` nunca llega a competir. Medido con el servidor real (`CORTEX_STRICT_NOTES=1`,
`CORTEX_APP_MODE=strict`): bitácora con `force: true` + `reason` → `isError: true` sobre `title`; app
desconocida con `force` → `isError: true` sobre `app`. El cambio no altera el comportamiento: lo
especifica y lo explica en el mensaje y en la descripción de la tool.

Alternativa descartada: que `force` + `reason` salte el modo estricto. Hace que el modo estricto sea
cosmético (el agente siempre puede escribir un `reason`) y obliga a decidir qué pasa con
`CORTEX_APP_MODE=strict`, que hoy es una validación de datos, no de calidad.

El importador usa `force: true` (`src/import.ts:199-210`) y por eso queda sujeto a ambos modos: no se
exceptúa. El operador que importa con modo estricto recibe el rechazo por archivo en el reporte y código 1
(medido); el README lo dice.

## D2 — `cortex_apps` con `respuestaJson`

`respuesta.ts` ya exporta `respuestaJson` y su comentario dice que los handlers la usan «para que nadie
vuelva a poner `null, 2`»; `cortex_apps` es el único handler que no (`src/tools/mcp-server.ts:391-402`).
No cambia el contenido, solo la serialización. `GET /api/apps` ya responde compacto (lo serializa Elysia).

## D3 — Compose: defecto `1440` para el TTL, vacío para el modo estricto

`parseSessionTtlMinutes('')` devuelve 1440 pero escribe el aviso «valor inválido '', usando 1440»
(`src/tools/sessions.ts`; medido). Con `${MCP_SESSION_TTL_MINUTES:-}` ese aviso saldría en cada arranque
del contenedor, por eso el compose lleva `${MCP_SESSION_TTL_MINUTES:-1440}`. `CORTEX_STRICT_NOTES` vacío
equivale a apagado (`src/db/note-quality.ts:47-50`), así que `${CORTEX_STRICT_NOTES:-}` es seguro.

## D4 — Filtro `app` en blanco

Tres lugares evalúan `filter.app` por veracidad y por lo tanto tratan `"   "` como valor:
`buildListFilter` (`src/db/notes.ts:566`), `lexicalSearch` (`src/db/notes.ts:734`, sin llamadores en
`src/`) e `hybridSearch` (`src/db/search.ts:84`). El arreglo es el mismo en los tres: `filter.app?.trim()`.
`GET /api/search` pasa por `hybridSearch`, así que queda cubierto.

## Riesgos

- La decisión D1 (opción 1) ya está tomada: quien quiera invertirla después tendrá que invertir el requirement
  «El modo estricto de bitácoras no se salta con force» y las tareas 1.4, 3.3 y 4.4–4.5.
- Ningún cambio toca migraciones ni el esquema de Prisma: reversión = revertir el commit.
