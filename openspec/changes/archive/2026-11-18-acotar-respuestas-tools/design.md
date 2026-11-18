## Contexto

Las tools devuelven texto al contexto del agente. Mediciones (corpus sintético de 79 notas con la forma del real, BD de medición propia, servidor levantado desde este worktree; tokens ≈ caracteres / 4, regla gruesa — el ahorro real en tokens de quitar indentación es menor que el de caracteres porque los espacios repetidos tokenizan barato, y no se midió con un tokenizador):

| Respuesta | Antes (chars) | Después (chars) |
|---|---|---|
| `cortex_list` sin args, 79 notas | 33.916 | 16.478 (50 ítems, compacto, con envoltorio) |
| `cortex_list` `kind: regla` | 2.105 | 1.612 |
| `cortex_history` nota de 2 revisiones | 8.185 | 452 |
| `cortex_history` nota de 30 mil chars, 4 revisiones | 104.754 | 892 |
| `cortex_search` 10 resultados | 4.223 | 3.802 (solo compacto; el snippet cambia de contenido, no de tamaño) |

«Después» de `list` e `history` es una simulación sobre los mismos datos (quitar `body_md`, cortar a 50, serializar compacto); el coder y QA remiden con el código real.

## Decisiones

**D1 — Envoltorio `{ total, items, next_offset }` en `cortex_list` y `{ total, items }` en `cortex_history`.** Un arreglo pelado no puede decir que hay más. Alternativa descartada: mantener el arreglo cuando no llegan `limit`/`offset`: el defecto 50 recortaría en silencio sin ninguna señal, que es peor que el problema. Costo asumido: rompe a quien parsee el arreglo; en este repo solo lo hacen los tests (`grep` en `src/`, `scripts/`, `skills/`, `docs/`: únicamente la definición en `src/tools/mcp-server.ts` y la mención en `skills/cortex-mcp/SKILL.md`).

**D2 — Paginación por `offset`, no por cursor.** Corpus de cientos de notas y 5–10 usuarios: `offset` es una línea, el agente lo entiende y el valor de `next_offset` se copia tal cual. Limitación conocida y aceptada: si una nota se actualiza entre dos páginas pasa al inicio (`updated_at` desc) y puede repetirse u omitirse una vez. Orden: `updated_at` descendente y, ante empate, `id` descendente (hoy no hay desempate, `src/db/notes.ts:509`). Sin migración: se supone que ordenar unas miles de filas no necesita índice nuevo (no medido a esa escala; con 79 filas no hay diferencia).

**D3 — `cortex_history`: `limit` (1–100, defecto 10, las más recientes, devueltas en `rev` ascendente), `include_body` (defecto `false`) y `rev` (entero ≥ 1).** `rev` gana sobre `limit` e `include_body` y siempre trae el cuerpo. La nota vigente no está en el historial (el historial guarda versiones anteriores, `src/db/notes.ts:571-590`), así que `rev` = vigente da error con la pista de usar `cortex_read`. Implementación: `findMany` con `orderBy rev desc, take limit`, invertir; `count` para `total`.

**D4 — Capa de datos aditiva.** `listNotes` y `getNoteHistory` conservan firma y comportamiento (los usan `src/index.ts:98` y 13+ tests de `test/notes.test.ts`). Se agregan `listNotesPage(prisma, filter, {limit, offset})` → `{ total, items }` y `getNoteHistoryPage(...)`. `listNotes` y `listNotesPage` comparten el `where`. No usar `$transaction([count, findMany])`: `src/db/retry.ts:115` clasifica `$transaction` como escritura (solo reintenta si la consulta no llegó a la BD) y rompería el reintento de lecturas de #16; usar `Promise.all([count, findMany])`.

**D5 — El filtro `tags` pasa a SQL.** Hoy se aplica en memoria después de leer todo (`src/db/notes.ts:514-517`); con `take/skip` eso daría páginas cortas y `total` falso. Se usa `tags: { array_contains: tags }` de Prisma (equivale a `tags @> ...::jsonb`, igual que `src/db/search.ts:89`). Verificado contra el filtro en memoria sobre 8 combinaciones de tags en la BD de medición (5 con resultados no vacíos; iguales en todas). Una lista vacía no filtra: no pasar `array_contains: []`.

**D6 — Snippet léxico con `ts_headline` sobre `unaccent(body_md)`.** El índice se construye con `to_tsvector('spanish', unaccent(title || ' ' || body_md))` (`prisma/migrations/20261103225733_initial/migration.sql:58`) y la consulta con `unaccent(q)`. Medido: `ts_headline('spanish', body_md, websearch_to_tsquery('spanish', unaccent('evaluación')))` **no resalta nada** si el cuerpo tiene tilde (devuelve el inicio del texto, es decir, el mismo defecto de hoy); sobre `unaccent(body_md)` sí. Consecuencia declarada: el snippet léxico sale sin tildes. Opciones de texto: `'MaxWords=35,MinWords=15,StartSel="",StopSel=""'` (medido: `StartSel=,StopSel=` sin comillas rompe el parseo y mete `,StopSel=` en el texto). Se calcula **después** de la fusión y solo para los resultados léxicos/`both` ya recortados a `limit` (16 ms para 10 filas, 43 ms para 50), en una consulta `WHERE id = ANY(...)`. Los resultados solo semánticos conservan los primeros 200 caracteres con tildes. Tope de 400 caracteres en JavaScript con `…` (una palabra sin espacios de 30 mil caracteres no debe volver como snippet). `ts_headline` no reduce tamaño (≈ 100-150 caracteres, como los 200 actuales): mejora relevancia.

**D7 — JSON compacto con una sola función.** `src/tools/respuesta.ts` exporta `respuestaJson(valor)` = `JSON.stringify(valor)`; los 8 sitios la usan, para que nadie vuelva a indentar y el tope viva junto.

**D8 — Tope de 20.000 caracteres solo en `cortex_list` y `cortex_history`.** Son las únicas con envoltorio donde se puede decir «hay más». `cortex_search` ya está acotada (50 resultados × ≈ 380 = 19.003 medido, snippet ≤ 400); `cortex_read` devuelve la nota completa por diseño; `history` con `rev` es lectura puntual. Algoritmo: serializar; si supera 20.000 y hay más de un ítem, quitar ítems enteros (list: del final; history: los más antiguos) hasta que quepa; dejar siempre al menos uno, aunque ese ítem solo supere el tope; agregar `truncated: true` solo si se quitó algo; en `list`, `next_offset` = `offset` + ítems conservados (o `null` si ya no queda nada). Alternativa descartada: cortar el texto a 20.000 caracteres (deja JSON inválido).

**D9 — `issue` y `force_reason`.** Ya viajan en cada ítem de `cortex_list`: `toNoteDto` los incluye (`src/db/notes.ts:147-162`) y el handler solo quita `body_md` (`src/tools/mcp-server.ts:311`). Se mantienen. El historial no puede traerlos (la tabla de revisiones no los guarda). `force_reason` sin tope de largo puede inflar un ítem de lista: lo cubre el tope D8.

## Riesgos

- **Cambio de forma** de dos respuestas: tests de `test/mcp.test.ts` y `test/delete.test.ts` que parsean un arreglo se actualizan (lista en `tasks.md` 2.5).
- **Los tests acumulan notas**: `test/mcp.test.ts:35` hace `TRUNCATE notes` por archivo, pero un test que cuente notas con `cortex_list {}` pasaría vacuamente cuando haya más de 50 (antes y después valdrían 50). Esos tests usan `total`.
- **Conflicto con #11** en `src/tools/mcp-server.ts` (ver `propuesta.md`).
- **Snippet sin tildes** en resultados léxicos (D6).
