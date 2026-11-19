# Design — Avisos de calidad al escribir una nota

## Context

`kind` se valida contra `NOTE_KINDS` en la capa de datos (`src/db/notes.ts`, `validateCreate` y
`updateNote`) y en el schema de las tools (`src/tools/mcp-server.ts`), pero nada mira la forma del contenido.
El agente que escribe es el único que puede corregirlo, y para eso necesita la señal en la misma respuesta.

## Decisions

### D1 — Heurísticas en un módulo puro, no en la capa de datos

`src/db/note-quality.ts` expone `isJournalNote`, `noteWarnings`, `journalField` e `isStrictNotesMode`: regex
sobre título/cuerpo, sin IO. Se testean sin Postgres ni el modelo ONNX (un archivo de test que corre en
milisegundos), y la capa de datos sólo usa `isJournalNote` para el modo estricto.

Alternativa descartada: calcular los avisos dentro de `createNote`/`updateNote` y cambiar sus tipos de
retorno — obliga a tocar `WriteResult` y el DTO de actualización para un dato que no se persiste.

### D2 — El aviso se arma en la tool, desde la nota ya guardada

`createNote`/`updateNote` devuelven la nota final (título, cuerpo y `kind` ya resueltos), así que la tool
calcula los avisos sobre ese objeto: sirve igual para la creación y para la actualización parcial, sin que la
tool tenga que recomponer el contenido vigente.

### D3 — `warnings` aparece sólo cuando hay algo que advertir

Se agrega el campo al JSON de la respuesta, no se envuelve la nota en un objeto nuevo: `{ ...note, warnings }`.
Sin avisos, la respuesta es byte a byte la de antes — los consumidores existentes (y sus tests) no cambian.

### D4 — Modo estricto: flag de entorno, leído en cada llamada

`CORTEX_STRICT_NOTES=1|true|yes` (default: apagado). Se lee en cada llamada y no al importar el módulo para
que un test lo pueda prender y apagar sin reiniciar el proceso. El rechazo es un `ValidationError` en
`validateCreate` — después de las validaciones de campos obligatorios, así el mensaje más útil gana: con
`kind` inválido y título de bitácora, el error nombra `kind`.

### D5 — El modo estricto no aplica a `cortex_update`

Una actualización es también el camino para **arreglar** una nota mal formada; rechazarla por parecer
bitácora dejaría el corpus sin salida. Por eso el chequeo estricto vive sólo en `validateCreate`.

## Risks

- **Falso positivo en modo estricto**: un título legítimo que empiece con `Cierre` (p. ej. una regla de
  cierre contable) se rechaza. Mitigación: el modo estricto es opt-in y el mensaje dice cómo desactivarlo;
  por defecto sólo se advierte.
- **Ruido de avisos**: `flujo` sin lista de pasos advierte aunque el texto describa el proceso en prosa —
  es el comportamiento pedido por el issue, y el aviso es no bloqueante.
