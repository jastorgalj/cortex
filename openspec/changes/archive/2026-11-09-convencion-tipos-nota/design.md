# Design — convención de tipos cerrada

## Context

Ver `proposal.md - Why`. El código hoy repite el enum de `kind` en tres `z.enum` de
`src/tools/mcp-server.ts` además del `NOTE_KINDS` de `src/db/constants.ts`, y ninguno describe qué
significa cada tipo. El `kind` es `TEXT` en el esquema (`prisma/schema.prisma:15`), así que el enum
es una convención de la capa de aplicación, no del esquema: quitarlo o corregirlo no migra datos.

## Goals / Non-Goals

- **Goals**: una sola lista de tipos y una sola lista de significados; las tools derivan de ellas; el
  agente lee el significado al llamar la tool; poder corregir la clasificación sin borrar la nota.
- **Non-Goals**: no se toca el esquema de Prisma (ninguna columna nueva, `note_revisions` sigue sin
  `app`/`kind`); no se reemplaza la nota `regla` de convención (esqueletos, llaves de app, reglas de
  título/tags) — solo se duplica el significado corto en el schema de la tool.

## Decisions

- **D1 — Una sola fuente para tipos y significados.** `src/db/constants.ts` define
  `NOTE_KINDS = ['sistema','flujo','decision','pitfall','regla'] as const` y un mapa nuevo
  `NOTE_KIND_DESCRIPTIONS: Record<NoteKind, string>`. Las `z.enum` de las tools se escriben como
  `z.enum(NOTE_KINDS)` y su `.describe()` interpola los significados del mapa (o usa la cadena
  compuesta). Alternativa descartada: un archivo nuevo de «schema compartido» — agrega una capa sin
  ganancia, `constants.ts` ya es la casa de `NOTE_KINDS`.

- **D2 — El texto del significado (redactado por el explorer, revisar en review).** Cinco definiciones
  cortas, alineadas con la skill (`skills/cortex-mcp/SKILL.md:60`):
  - `sistema` — cómo funciona un sistema o módulo (qué hace, cómo se usa).
  - `flujo` — un proceso con pasos u orden que importa, y sus trampas.
  - `decision` — por qué se decidió algo, con su contexto y la alternativa descartada.
  - `pitfall` — una trampa o error ya sufrido, con su causa y su arreglo.
  - `regla` — una regla del equipo que no está escrita en el código.
  Son provisionales hasta el review del proposal: no son contrato de spec (el spec solo pide «describe
  cada tipo»), así que se ajustan sin tocar el delta.

- **D3 — Corrección de clasificación en `cortex_update` (decisión de Juan, 2026-11-09: habilitar `kind` y
  `app`).** Se agregan `app` y `kind` opcionales a `UpdateInput` (`src/db/notes.ts:93`) y al schema de
  `cortex_update` (`src/tools/mcp-server.ts:176`), se validan (kind contra `NOTE_KINDS`, app no vacío) y se
  escriben en el `tx.note.update`. **La revisión anterior no captura el `kind`/`app` viejos**:
  `note_revisions` no tiene esas columnas, y agregarlas tocaría el esquema (fuera de alcance). La
  corrección descarta el valor equivocado, lo cual es aceptable: no es conocimiento que valga conservar.
  Alternativa descartada: capturar la clasificación anterior en `note_revisions` con una columna nueva —
  contradice «ninguno toca el esquema».

## Risks / Trade-offs

- **Un cambio de tipo no deja rastro en el historial** → la clasificación es metadata corregible, no
  contenido; el contenido y su autoría sí quedan en `note_revisions`. Se documenta en el change y, si el
  usuario quiere auditoría de clasificación, es un change aparte con migración.
- **Derivar `z.enum(NOTE_KINDS)` cambia el contrato de types** → `NoteKind = typeof NOTE_KINDS[number]`
  ya existe y se usa en `NoteDto`/`toNoteDto`; al quitar `otro` el typecheck acusa cualquier uso de
  `'otro'` como literal de tipo, lo que ayuda a no dejar restos.
- **La descripción del `kind` puede divergir de la skill** → ambas se derivan del mismo texto (D2); si
  cambia, se cambia en `constants.ts` y se revisa la skill en el mismo PR.

## Migration Plan

Sin migración de datos. En deploy, las filas existentes ya son de los cinco tipos (verificado en test:
0 filas `otro`). El cambio es de aplicación y tests; no requiere pasos de rollback más allá de revertir
el PR.
