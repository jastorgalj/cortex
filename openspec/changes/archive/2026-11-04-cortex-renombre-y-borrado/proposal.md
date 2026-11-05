## Why

El servidor de conocimiento se entregó en v1 con dos defectos que solo aparecieron al usarlo:

1. **No tiene nombre de producto.** Se llama `novara-knowledge-mcp`, sus tools son `kb_*` y la vista web dice «Novara KB». Un equipo no adopta algo que se llama como su carpeta. Se adopta el nombre **Cortex** (la memoria compartida del equipo de desarrollo y de sus agentes).
2. **No se puede borrar una nota por MCP.** El spec vigente de `notas` exige borrado lógico («El borrado es lógico») y el código ya lo implementa (`softDeleteNote` en `src/db/notes.ts`), pero ninguna de las seis tools lo expone. Verificado en la prueba con dos usuarios: llamar a `kb_delete` responde `Tool kb_delete not found`. Una nota de prueba o equivocada solo se puede quitar con SQL directo, lo que contradice la regla del proyecto de que toda escritura pasa por las tools (validación, revisiones, autoría).

## What Changes

- **BREAKING** Las seis tools pasan de `kb_*` a `cortex_*`: `cortex_search`, `cortex_read`, `cortex_write`, `cortex_update`, `cortex_list`, `cortex_history`. No se deja alias `kb_*` (ver design, Decisión 1).
- Nueva tool `cortex_delete(id, author, reason)`: borrado lógico con autoría y motivo obligatorios; deja una revisión final visible en `cortex_history`. Total: **siete tools**.
- El servidor se identifica como `cortex`: nombre en el `initialize` MCP, título de la vista web, prefijo de logs, `name` y `version` de `package.json`, README. La versión pasa de 0.1.0 a 0.2.0 por el cambio incompatible de nombres.
- Los textos de error y las pistas que mencionan tools (`Error en kb_update`, «usa kb_update sobre el id candidato», «Lee la nota de nuevo con kb_read») pasan a los nombres nuevos.
- Los tests y el README se actualizan a los nombres nuevos y a la tabla de siete tools.

## Capabilities

### New Capabilities

Ninguna: el borrado por tool y el nombre del producto extienden capabilities existentes.

### Modified Capabilities

- `servidor-mcp`: pasa de seis a siete tools con prefijo `cortex_` (REMOVED + ADDED, porque el nombre del requirement y el escenario «exactamente seis» dejan de ser verdad); el servidor se identifica como Cortex; la API REST de solo lectura cita `cortex_search` y `cortex_read`.
- `notas`: nuevo requirement para el borrado por tool con autoría, motivo y rastro en el historial; los requirements existentes que nombran tools se reescriben con los nombres nuevos.
- `busqueda`: los requirements que nombran `kb_search`, `kb_write` y `kb_list` se reescriben con los nombres nuevos; el comportamiento no cambia.

## Impact

- Código: `src/tools/mcp-server.ts` (registro y mensajes de las tools, nombre del server), `src/db/notes.ts` (`softDeleteNote` con autoría y revisión), `src/db/search.ts` (comentario), `src/web/views.ts` (títulos), `src/index.ts` (prefijo de logs).
- Tests: `test/mcp.test.ts`, `test/api.test.ts`, más pruebas nuevas del borrado.
- Docs: `README.md`, `package.json`.
- Sin migración de base de datos: el borrado usa `notes.deleted_at` y `note_revisions`, que ya existen.
- Consumidores: el único cliente registrado hoy es la entrada `cortex` de Hermes (hecha con las tools `kb_*`); se re-registra tras el cambio para refrescar su cache de tools (paso del orquestador, no de una card).

## Fuera de alcance

- **Renombrar la carpeta del repo, las bases de datos (`cortex`, `cortex_test`), el servicio del compose y el cache del modelo (`~/.model-cache/knowledge-mcp`).** Razón: renombrar datos o rutas que no ve el usuario no aporta nada y renombrar el cache obligaría a re-descargar ~420 MB del modelo; la carpeta tiene worktrees activos y se renombra aparte.
- **Una tool para restaurar notas borradas.** Razón: no se pidió; el borrado es lógico, así que la restauración sigue siendo posible directamente en la base. Si el equipo la necesita, es un change propio.
- **Alias `kb_*` de transición.** Razón en design, Decisión 1.
- **Skill de Hermes que enseñe a los agentes cuándo leer y escribir en Cortex.** Es el siguiente paso natural, pero es otro entregable.
- **Publicar en un remoto, desplegar o configurar a otros usuarios.** El repo no tiene remote todavía.
