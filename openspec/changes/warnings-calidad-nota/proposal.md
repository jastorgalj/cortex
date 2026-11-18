# Proposal — Avisos de calidad al escribir una nota

## Why

En uso real llegan notas tipo bitácora (títulos `Cierre <TICKET>: MR !93 …`) y notas con `kind` que no
corresponde a su contenido (un cierre de ticket guardado como `decision`). El `kind` se valida contra el
enum cerrado, pero nada verifica que el contenido calce con el tipo ni avisa cuando lo guardado es registro
de actividad: esas notas ensucian la búsqueda y disparan falsos `similar_exists` (`#15`).

## What Changes

- **`cortex_write` y `cortex_update` devuelven `warnings`.** Campo opcional en la respuesta (no bloqueante):
  la nota se crea/actualiza igual y el agente recibe el motivo. Una nota bien formada devuelve exactamente
  el JSON de siempre, sin campo extra.
- **Heurística de bitácora.** Título de registro de actividad (`Cierre`, `Sesión`, `Log`, `Bitácora`…),
  referencia `MR !N` / `PR #N` en el título, o fecha ISO al inicio del título o del cuerpo.
- **Heurística por `kind`.** `decision` sin motivo ni alternativa descartada, `pitfall` sin causa o sin
  arreglo, `flujo` sin lista de pasos: el aviso incluye el esqueleto esperado, derivado de
  `NOTE_KIND_DESCRIPTIONS`. `sistema` y `regla` no tienen heurística de forma.
- **Modo estricto opt-in.** `CORTEX_STRICT_NOTES=1` rechaza la bitácora con `ValidationError` en la capa de
  datos en vez de advertir. Default: advertir (una nota legítima nunca se pierde por una heurística).
- **Documentación.** README (qué se advierte y qué activa el modo estricto) y `.env.example`.

## Capabilities

- **New Capabilities**: ninguna.
- **Modified Capabilities**: `notas` — un requirement nuevo sobre los avisos de calidad y el modo estricto.

## Fuera de alcance

- **Sugerir `kind` por similitud del embedding contra centroides por tipo** (propuesta 2, último punto del
  issue): requiere medir centroides sobre datos reales antes de fijar umbrales, y no hace falta para que el
  agente se autocorrija con el aviso. Queda para un issue propio si el aviso simple no alcanza.
- **Bloquear contenido sospechoso en `cortex_update`:** el modo estricto sólo aplica a la creación; una
  actualización puede corregir una nota hacia cualquier forma, y rechazarla impediría arreglarla.
- **Persistir los warnings:** no se guardan en la nota ni en el historial; son una señal de la respuesta.
