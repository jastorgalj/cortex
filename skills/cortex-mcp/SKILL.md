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
Encontré algo relevante      → cortex_read (la nota completa, no el snippet)
Aprendí algo que el equipo debe saber:
   ¿ya existe?               → cortex_update (reason; y base_rev si la leí antes)
   ¿no existe?               → cortex_write (author + app + kind)
Una nota está mal o sobra    → cortex_delete (author + reason)
```

Buscar es parte de empezar, no un extra: una tarea resuelta dos veces porque nadie buscó es el costo que
Cortex evita.

## La convención vigente

Las llaves de sistema, los cinco tipos con su esqueleto y las reglas de título, tags y granularidad viven
en Cortex, no en esta skill: `cortex_list(app: "general", kind: "regla")`. Leela antes de escribir la
primera nota de un sistema; si algo no encaja en los cinco tipos, se propone por issue, no se inventa.

## La nota

| Campo | Qué es |
|---|---|
| `title`, `body_md` | Título corto y contenido en Markdown |
| `app` | Llave del sistema: el producto (`console`, `omnisales-pos`, `licitapro`, `general`…) |
| `kind` | `sistema`, `flujo`, `decision`, `pitfall`, `regla` — cinco, sin `otro` |
| `tags` | Con prefijo: `area:`, `repo:`, `stack:`, `env:` (los valores, en la nota de convención); `origen:` lo reserva el importador |
| `author` | Quién escribe (**obligatorio** en toda escritura) |
| `issue` | Ticket de origen, opcional (`CAR-287`, `#134`, una URL) |

`kind` no es decorativo: `regla` es lo que se lista al empezar una tarea en esa app, `pitfall` es lo que
evita repetir un error, `decision` es lo que responde «¿por qué está así?».

## Deduplicado: el servidor avisa, vos decidís

Antes de crear, el servidor compara y responde `similar_exists` si hay algo parecido:

- **Misma idea, otra redacción** → `cortex_update` sobre la existente, con `reason`.
- **Idea distinta que se parece** → crear con `force: true` (y tags que la distingan).
- Nunca dos notas para lo mismo: la segunda se desactualiza y miente.

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
