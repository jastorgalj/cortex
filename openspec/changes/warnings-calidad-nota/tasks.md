# Tasks — Avisos de calidad al escribir una nota

## 1. Heurísticas puras

- [x] 1.1 `src/db/note-quality.ts` con `isJournalNote` (título de registro, `MR !N`/`PR #N` en el título,
      fecha ISO al inicio del título o del cuerpo), `journalField`, `noteWarnings` (bitácora + forma según
      `kind`) e `isStrictNotesMode` (`CORTEX_STRICT_NOTES`)
- [x] 1.2 Esqueletos de los avisos derivados de `NOTE_KIND_DESCRIPTIONS` (sin textos duplicados)

## 2. Integración

- [x] 2.1 `validateCreate` rechaza la bitácora con `ValidationError` cuando `CORTEX_STRICT_NOTES` está activo
      (después de las validaciones de campos obligatorios)
- [x] 2.2 `cortex_write` y `cortex_update` agregan `warnings` a la respuesta sólo cuando hay avisos
      (`withWarnings` en `src/tools/mcp-server.ts`), sumados a los warnings de vocabulario de `app` que
      ya emite la capa de datos (un solo campo para el agente)
- [x] 2.3 Descripción de `cortex_write` menciona el campo `warnings`

## 3. Documentación

- [x] 3.1 README: qué se advierte (bitácora y forma según `kind`) y qué activa el modo estricto
- [x] 3.2 `.env.example`: `CORTEX_STRICT_NOTES`

## 4. Verificación

- [x] 4.1 `test/note-quality.test.ts` — 17 casos de las heurísticas (sin BD ni modelo)
- [x] 4.2 `test/notes.test.ts` — bitácora creada por defecto, rechazada en modo estricto, nota de
      conocimiento creada en modo estricto
- [x] 4.3 `test/mcp.test.ts` — `cortex_write` de bitácora devuelve `warnings`; nota bien formada no lo trae
- [x] 4.4 `bun run typecheck` sin errores
- [x] 4.5 `bun run test` (tras mergear `main` con #22): 276 pass / 3 fail; los 3 fallos (`health`,
      `shutdown`) se reproducen igual en un worktree limpio de `origin/main` — son de ambiente (timeouts de
      3 s), no de este cambio
