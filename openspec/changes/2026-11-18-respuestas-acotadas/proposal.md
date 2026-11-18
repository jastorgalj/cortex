# Proposal — Respuestas MCP acotadas: paginación, historial sin cuerpos, JSON compacto y snippet contextual

## Why

Las respuestas de las tools van íntegras al contexto del agente y crecen con el corpus (GitHub #17).
Con ~80 notas ya se ven respuestas largas:

- `cortex_list` devolvía **todas** las notas que cumplían el filtro: `findMany` sin `take`/`skip`
  (`src/db/notes.ts:522-561` antes de este cambio) y la tool sin `limit`/`offset`
  (`src/tools/mcp-server.ts:277-300`).
- `cortex_history` devolvía **todas** las revisiones con su `body_md` completo
  (`src/db/notes.ts:629-647`, `src/tools/mcp-server.ts:303-324`): el histórico de una nota editada
  muchas veces es el cuerpo entero repetido N veces.
- Todas las respuestas usaban `JSON.stringify(x, null, 2)`: la indentación no aporta información al
  agente y suma tokens en cada llamada.
- El snippet de búsqueda eran los primeros 200 caracteres del cuerpo, no el fragmento donde matcheó
  el término (`src/db/search.ts:23-25`): si el término aparecía después, el resultado no lo mostraba
  y el agente tenía que leer la nota completa para confirmarlo.

## What Changes

- **`cortex_list` paginado**: `limit` (default 50, máx 200) y `offset`; la respuesta pasa a
  `{ total, items, next_offset }`. `next_offset` es `null` en la última página. La capa de datos gana
  `listNotesPage` (`src/db/notes.ts:581`), que hace `count` + `findMany` con `take`/`skip`; `listNotes`
  (lista completa, usada por la vista web) comparte el mismo `where` (`buildListWhere`,
  `src/db/notes.ts:535`).
- **`cortex_history` sin cuerpos por defecto**: metadatos (`rev`, `title`, `tags`, `author`, `reason`,
  `created_at`) de las 10 revisiones más recientes; `include_body: true` trae los cuerpos y `rev: N`
  trae el cuerpo de una revisión puntual. La respuesta pasa a `{ total, items }`
  (`src/db/notes.ts:682`).
- **JSON compacto** en todas las respuestas de las tools (`JSON.stringify(x)`, sin indentación).
- **Snippet contextual**: `ts_headline('spanish', unaccent(body_md), tsquery, 'MaxWords=35,MinWords=15')`
  en la rama léxica de la búsqueda híbrida y en `lexicalSearch`; los resultados solo semánticos
  conservan el inicio del cuerpo como snippet (`src/db/constants.ts:27`,
  `src/db/search.ts:115`, `src/db/notes.ts:717`). Los marcadores `<b>` de `ts_headline` se quitan
  (`cleanSnippet`, `src/db/constants.ts:35`).

## Capabilities

### New Capabilities

Ninguna.

### Modified Capabilities

- `servidor-mcp`: requirements nuevos para el listado paginado, el historial con metadatos por defecto
  y el JSON compacto de las respuestas.
- `busqueda`: «Búsqueda híbrida con fusión de rankings» — el snippet pasa a ser el fragmento que
  contiene el término, no los primeros 200 caracteres.

## Fuera de alcance

- Tope duro de caracteres por respuesta con aviso `truncated: true` (punto 5 del issue, marcado como
  opcional): con paginación e historial sin cuerpos las respuestas ya están acotadas, y un tope ciego
  cortaría cuerpos legítimos de `cortex_read`.
- Paginación por cursor sobre `updated_at` (el issue la ofrece como alternativa a `offset`): `offset`
  es el mismo contrato con menos código y mantiene el orden estable que ya promete el listado.
- Paginar `cortex_search`: ya está acotado (`limit` 1-50, default 10) con snippet corto.
- Cambios de esquema y migraciones: no hacen falta.
