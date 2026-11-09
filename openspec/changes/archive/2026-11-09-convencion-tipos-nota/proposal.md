# Proposal — Cinco tipos de nota, cerrados en el servidor

## Why

La taxonomía de `kind` quedó con un sexto valor —`otro`— que el usuario ya decidió que no debe existir:
«Dejemos esos tipos; si después se necesita cambiar algo, pasa por un issue y se agrega». El enum está
cerrado a cinco tipos (`sistema`, `flujo`, `decision`, `pitfall`, `regla`) en la skill (`skills/cortex-mcp/SKILL.md:55`)
pero el código y el spec todavía lo enumeran con `otro` (`src/db/constants.ts:16`,
`src/tools/mcp-server.ts:38,93,253`, `openspec/specs/notas/spec.md:13`). Ese sexto valor invita a
clasificar «otra cosa», degenera el rescate determinista y contradice la convención ya aprobada.

## What Changes

- **Quitar `otro`.** El enum de `kind` pasa a cinco tipos en el código (`src/db/constants.ts`), en las
  tres `z.enum` de las tools (`src/tools/mcp-server.ts`) y en la documentación (`README.md:41`). La
  validación real (`src/db/notes.ts:154`) se deriva de `NOTE_KINDS`, así que rechaza `otro` al quitar el
  literal. **Sin migración**: `kind` es `TEXT` en el esquema (`prisma/schema.prisma:15`) y no hay filas
  con `kind='otro'` (verificado contra la BD de test: 0 filas).
- **Lista de tipos en un solo lugar.** `NOTE_KINDS` (array) + un mapa nuevo `NOTE_KIND_DESCRIPTIONS`
  (tipo → significado) viven en `src/db/constants.ts`. Las `z.enum` de las tools y sus `.describe()` se
  derivan de esas constantes, en vez de repetir los literales en tres lugares.
- **El significado de cada tipo en la descripción del campo `kind`.** El `.describe()` del campo `kind`
  de `cortex_write`/`cortex_search`/`cortex_list` pasa a llevar una definición corta de cada tipo, para
  que el agente la lea al llamar la tool y no dependa de leer una nota ni la skill.
- **Corregir la clasificación en `cortex_update`.** Habilitar `app` y `kind` opcionales en `cortex_update`,
  validados (`kind` contra el enum, `app` no vacío), para corregir una clasificación equivocada sin borrar
  la nota ni perder su historial (decisión de Juan, 2026-11-09).

## Capabilities

### New Capabilities

Ninguna. Los cambios son correcciones de comportamiento ya especificado en `notas` y en `servidor-mcp`.

### Modified Capabilities

- `notas`: el requirement «Una nota tiene autoría declarada y clasificación estructurada» cambia —el enum
  pasa de seis a cinco tipos y `otro` deja de ser válido—, y se agrega el requirement «La actualización
  puede corregir la clasificación».
- `servidor-mcp`: el requirement «Las tools declaran su schema y responden errores descriptivos» agrega
  que el campo `kind` describe el significado de cada tipo.

## Impact

- Código: `src/db/constants.ts` (enum + mapa de descripciones), `src/tools/mcp-server.ts` (derivar
  `z.enum` y descripciones; schema de `cortex_update`), `src/db/notes.ts` (validación y escritura de
  `app`/`kind`), `README.md` (tabla de campos), `test/notes.test.ts` (fixtures y casos de corrección).
- Esquema: **sin migración** (se usan las columnas `kind`/`app` existentes).
- Tests: `test/notes.test.ts` (los dos fixtures con `kind: 'otro'` pasan a un tipo válido; casos nuevos
  para rechazo de `otro` y para actualizar `kind`/`app`).
- Contrato de las tools: `cortex_write`/`cortex_search`/`cortex_list` no cambian de firma (solo el texto
  de la descripción de `kind` y el conjunto de literales). `cortex_update` agrega `app`/`kind` opcionales.
- Consumidores: el importador (`src/import.ts:111-126`) ya no puede producir `otro` (devuelve solo los
  cinco tipos o el default `pitfall`), así que no requiere cambio.

## Fuera de alcance

- **Capturar la clasificación anterior en `note_revisions`.** La tabla de revisiones guarda título, cuerpo,
  tags, autor y motivo; no guarda `app`/`kind`. Corregir la clasificación no deja el valor anterior en el
  historial (aceptable: la corrección descarta un valor equivocado). Guardarlo exigiría una columna nueva,
  lo que contradice «ninguno toca el esquema».
- **`base_rev` en `cortex_delete`.** Ya declarado fuera de alcance en un change anterior; no aplica acá.
- **Validar `author` contra una lista de autores.** Sigue declarativo, como el resto del modelo.
- **La convención completa (esqueletos, llaves de app, reglas de título/tags/granularidad).** Sigue
  viviendo en la nota `regla` de `general` (ver la skill); este change solo mueve el significado corto de
  cada tipo a la descripción del campo `kind`, no reemplaza esa nota.
