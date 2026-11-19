---
name: cortex-mcp
description: "Use when usás Cortex (MCP) para buscar o guardar notas."
version: 1.1.0
author: juan-hermes
license: MIT
metadata:
  hermes:
    tags: [cortex, mcp, memoria, conocimiento, equipo]
    category: productivity
---

# Cortex — memoria compartida vía MCP

Cortex es el servidor MCP donde el equipo (personas y agentes) deja lo que no se deduce del código: una
decisión y su porqué, un pitfall con su causa, un flujo con sus trampas. Si tenés las tools
`mcp__cortex__cortex_*`, esta skill te dice **cuándo** usarlas y **qué** escribir; el esquema de cada tool
ya lo trae el MCP.

## Antes de empezar: ¿está conectado?

Si no ves las tools `cortex_*`, no las inventes: avisá cómo conectar el servidor y seguí sin Cortex.

```bash
hermes mcp add cortex --url http://localhost:3091/mcp     # y abrir sesión nueva o /reload-mcp
claude mcp add --transport http cortex http://localhost:3091/mcp
```

## El ciclo, en orden

```
Empiezo una tarea en <app>   → cortex_search (q + app) y cortex_list con kind=regla
                              (ambos incluyen las notas de `general`, que son las transversales)
No sé qué apps existen       → cortex_apps (apps en uso con su conteo + vocabulario)
Retomo un ticket              → cortex_list o cortex_search con issue=<ID>
Encontré algo relevante      → cortex_read (la nota completa, no el snippet)
Aprendí algo que el equipo debe saber:
   ¿ya existe?               → cortex_update (reason; y base_rev si la leí antes)
   ¿no existe?               → cortex_write (app + kind; author opcional: se infiere del header x-cortex-author, nombre del cliente MCP, o 'agente')
Una nota está mal o sobra    → cortex_delete (author + reason)
```

`cortex_list` pagina de a 50 por llamada; seguir con `next_offset` cuando no es `null`. `cortex_history` trae metadatos de las 10 revisiones más recientes; pedir el cuerpo con `rev` para una revisión puntual.

Buscar es parte de empezar, no un extra: una tarea resuelta dos veces porque nadie buscó es el costo que
Cortex evita.

## La convención vigente

Las llaves de sistema, los cinco tipos con su esqueleto y las reglas de título, tags y granularidad viven
en Cortex, no en esta skill: `cortex_list(app: "general", kind: "regla")` (pagina de 50 por llamada; seguir con `next_offset` cuando no es `null`). Las notas de `general` son las
transversales: filtrar por cualquier `app` las incluye (salvo `include_general: false`), así que «no hay
reglas para mi app» casi siempre significa «están en `general`». Leela antes de escribir la primera nota
de un sistema; si algo no encaja en los cinco tipos, se propone por issue, no se inventa.

Si dudás del valor de `app`, no lo inventes: `cortex_apps` lista las apps vigentes con su conteo y el
vocabulario configurado. Un valor fuera del vocabulario queda guardado con un `warnings` (o se rechaza en
modo `strict`), y un alias configurado se persiste como su valor canónico.

## La nota

| Campo | Qué es |
|---|---|
| `title`, `body_md` | Título corto y contenido en Markdown |
| `app` | Llave del sistema: el producto (`console`, `omnisales-pos`, `licitapro`, `general`…). Se guarda en minúsculas; si el servidor declara vocabulario (`CORTEX_APPS`), un valor fuera de él vuelve como `warnings` |
| `kind` | `sistema`, `flujo`, `decision`, `pitfall`, `regla` — cinco, sin `otro` |
| `tags` | Con prefijo: `area:`, `repo:`, `stack:`, `env:` (los valores, en la nota de convención); `origen:` lo reserva el importador |
| `author` | Quién escribe. Obligatorio en `cortex_delete`; opcional en `cortex_write`/`cortex_update` (cadena: argumento > header `x-cortex-author` > nombre del cliente MCP > `agente`). |
| `issue` | Ticket de origen, opcional (`CAR-287`, `#134`, una URL) |

`kind` no es decorativo: `regla` es lo que se lista al empezar una tarea en esa app, `pitfall` es lo que
evita repetir un error, `decision` es lo que responde «¿por qué está así?».

## Deduplicado: el servidor avisa, vos decidís

Antes de crear, el servidor compara y responde `similar_exists` si hay algo parecido.
Leé las candidatas: traen `app`, `kind`, `issue`, `matched_by` (`coseno` o `issue_y_titulo`),
`same_issue` y `same_kind` para que puedas decidir qué hacer.

- **Misma idea, otra redacción** → `cortex_update` sobre la candidata con `id` indicado, con `reason`.
- **Idea distinta que se parece** → crear con `force: true` y `reason` explicando por qué no es un
  duplicado. El `reason` queda guardado en la nota (`force_reason`).
- **Buscá con `cortex_search` antes de crear**: una paráfrasis de otra nota puede quedar bajo el umbral
  y no avisar. Si no encontrás nada, recién creá.
- Nunca dos notas para lo mismo: la segunda se desactualiza y miente.
- `cortex_write` y `cortex_update` pueden devolver un campo `warnings` (no bloqueante) cuando el
  contenido parece una bitácora o no calza con su `kind`; una nota bien formada no lo trae. Con
  `CORTEX_STRICT_NOTES=1` la bitácora se rechaza en lugar de advertir, y `force` no anula ese rechazo.

## Concurrencia: dos agentes, una nota

`cortex_update` acepta `base_rev` (la revisión que leíste). Si otro la cambió en el medio, el servidor
**rechaza e informa la revisión vigente**: volvé a leer, integrá el cambio y reescribí. No reintentes con
la misma `base_rev` ni pises sin leer.

## Borrar deja huella

`cortex_delete` es lógico y exige `author` y `reason`. La nota sale de búsquedas y listados, el historial
guarda quién y por qué. Un dato equivocado se borra: dejarlo «por si acaso» envenena las búsquedas.

## Qué merece una nota y qué no

| Sí | No |
|---|---|
| Una decisión y su porqué | Lo que el código ya dice |
| Un pitfall: síntoma, causa, arreglo | El diff o el historial de git |
| Un flujo con trampas u orden obligatorio | El estado de una tarea de hoy |
| Una regla del equipo que no está escrita | Secretos, claves, tokens, datos personales |

El `body_md` lleva el conocimiento, no el archivo: si hace falta pegar 200 líneas de código, va el
`path:línea` y la conclusión.

## Antes de cerrar la tarea

Preguntate: *¿descubrí algo que el próximo no va a deducir del código?* Si la respuesta es sí y no existe
la nota, escribila ahora —después del cierre ya nadie la escribe.
