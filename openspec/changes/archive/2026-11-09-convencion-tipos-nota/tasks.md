# Tasks — convención de tipos cerrada

> Decisión Q1 resuelta (Juan, 2026-11-09): habilitar `app`/`kind` en `cortex_update`. El grupo 3 se ejecuta
> y el delta `ADDED` de `notas` se archiva tal cual.

## 1. Constantes y significados (D1, D2)

- [x] 1.1 Quitar `'otro'` de `NOTE_KINDS` en `src/db/constants.ts:16` (deja cinco tipos) y agregar el mapa
  `NOTE_KIND_DESCRIPTIONS: Record<NoteKind, string>` con las cinco definiciones de `design.md` D2.
- [x] 1.2 Confirmar con `bun run typecheck` que ningún literal `'otro'` queda como tipo (el typecheck acusa
  cualquier uso de `'otro'` como `NoteKind`).

## 2. Tools derivan de las constantes (a, b, c)

- [x] 2.1 En `src/tools/mcp-server.ts`, reemplazar las tres `z.enum(['sistema',...,'otro'])` de
  `cortex_search` (`:38`), `cortex_write` (`:93`) y `cortex_list` (`:253`) por `z.enum(NOTE_KINDS)` derivado.
- [x] 2.2 Reemplazar el `.describe()` del campo `kind` de las tres tools por una descripción que liste los
  cinco tipos con su significado (compuesta desde `NOTE_KIND_DESCRIPTIONS`), sin mencionar `otro`.
- [x] 2.3 Verificar que `tools/list` muestra el campo `kind` con la descripción nueva y sin `otro` (test
  MCP o inspección del schema).

## 3. Corrección de clasificación en `cortex_update`

- [x] 3.1 Agregar `app?: string` y `kind?: NoteKind` a `UpdateInput` (`src/db/notes.ts:93-100`) y validarlos
  en `updateNote`: `kind` contra `NOTE_KINDS`, `app` no vacío, rechazando con `ValidationError`.
- [x] 3.2 Escribir `app` y `kind` en el `tx.note.update` de `updateNote` (`src/db/notes.ts:307-316`) cuando
  vienen definidos.
- [x] 3.3 Agregar `app` y `kind` opcionales al schema de `cortex_update` (`src/tools/mcp-server.ts:176-182`),
  con `kind` como `z.enum(NOTE_KINDS)` y descripción, y pasarlos a `updateNote`.

## 4. Documentación

- [x] 4.1 En `README.md:41`, quitar `u otro` de la fila `kind` (queda «`sistema`, `flujo`, `decision`,
  `pitfall`, `regla`»).

## 5. Tests

- [x] 5.1 Reemplazar los `kind: 'otro'` de los fixtures en `test/notes.test.ts:220` y `:432` por un tipo
  válido (p. ej. `pitfall` o `sistema`).
- [x] 5.2 Agregar test: `createNote` con `kind: 'otro'` rechaza y el mensaje lista los cinco tipos (sin
  `otro`). Cubre el scenario «kind 'otro' rechazado».
- [x] 5.3 Agregar tests: `updateNote` con `kind` válido corrige y conserva el historial; con `kind: 'otro'`
  o `app` vacío rechaza sin modificar. Cubre los dos scenarios del requirement ADDED.
- [x] 5.4 Correr `bun run test` (baseline: 66 pass / 0 fail) y `bun run typecheck` y confirmar verde.

## 6. Verificación del change

- [x] 6.1 `openspec validate convencion-tipos-nota --type change --strict` sin errores ni warnings.
- [x] 6.2 Grep de `otro` (como tipo) en `src/`, `README.md` y `openspec/specs/**`: el único match en specs
  es la sección del delta que lo niega; en `src/` y `README.md` vacío. No contar los `otro` de archivos
  archivados ni los «otro» con otro sentido (p. ej. «otros dominios»).
  Verificado por el closer tras `openspec archive`: `src/` y `README.md` rc=1 (0 matches);
  `openspec/specs/notas/spec.md:13` = «enum cerrado de cinco tipos —sistema, flujo, decision, pitfall, regla—»;
  los 5 restantes (:26,:30,:32,:34,:178) son scenarios de rechazo. `openspec validate --specs` → 3 passed, 0 failed.
