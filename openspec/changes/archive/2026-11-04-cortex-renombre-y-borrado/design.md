## Context

v1 está construido, aprobado y funcionando contra Neon (44 notas importadas). Dos servidores locales sobre la misma base pasaron la prueba de visibilidad y de conflicto por `base_rev`. Este change no toca el modelo de datos: renombra la superficie pública y expone una operación que ya existe en el repositorio de datos.

## Goals / Non-Goals

**Goals**
- Nombre de producto coherente en todo lo que ve un usuario o un agente: tools, `initialize` MCP, vista web, logs, README.
- Borrado por MCP con la misma disciplina que el resto de las escrituras: autoría declarada y rastro.

**Non-Goals**
- Renombrar infraestructura invisible (carpeta, bases de datos, cache del modelo), restaurar notas, alias de transición, skill de agentes. Ver proposal, «Fuera de alcance».

## Decisions

### Decisión 1 — Renombre sin alias `kb_*`

Las tools `kb_*` se eliminan; no se mantiene un alias.

- **Por qué:** el único cliente registrado es la entrada `cortex` de Hermes, creada hace horas, y los dos servidores de prueba. Un alias duplicaría el `tools/list` (14 tools) y rompería el contrato «exactamente siete»; además el agente vería dos nombres para lo mismo y elegiría al azar.
- **Costo aceptado:** quien tenga el servidor registrado con la versión anterior debe re-registrarlo. Hoy es una sola entrada.
- **Alternativa descartada:** alias con deprecación. Tiene sentido con clientes que no controlas; aquí no existen.

### Decisión 2 — El borrado deja una revisión, no columnas nuevas

`cortex_delete` marca `deleted_at` (como hoy) y además inserta en `note_revisions` una revisión con la versión vigente, el **autor del borrado** y el **motivo**. `cortex_history` la muestra como última revisión.

- **Por qué:** el spec ya dice que el borrado conserva la fila y sus revisiones, pero sin autor ni motivo no se puede responder «quién borró esto y por qué», que es justo lo que se pregunta cuando alguien echa de menos una nota. Reutilizar `note_revisions` evita una migración (`deleted_by`, `delete_reason`) en dos bases (local y Neon) para un dato que ya tiene casa.
- **Alternativa descartada:** columnas `deleted_by`/`delete_reason` en `notes`. Exige migración, y el historial quedaría repartido en dos lugares.

### Decisión 3 — `author` y `reason` obligatorios en el borrado

Ambos SHALL venir no vacíos. `reason` es obligatorio aquí aunque en `cortex_update` el motivo sea opcional: borrar es la única operación que no se puede deshacer desde las tools, y un motivo de una línea cuesta menos que la nota perdida.

### Decisión 4 — Alcance del nombre: lo que ve el usuario, no la infraestructura

Se renombran tools, `serverInfo.name`, títulos web, prefijo de logs, `package.json` y README. No se renombran las bases de datos, el servicio del compose, la carpeta del repo ni `~/.model-cache/knowledge-mcp`.

- **Por qué:** renombrar el cache obliga a re-descargar ~420 MB del modelo en cada máquina sin ningún beneficio visible; renombrar las bases es una migración de datos; la carpeta del repo tiene worktrees activos. Se hacen aparte, si algún día molestan.

### Decisión 5 — Cómo se escribe el delta

Un requirement que solo cambia de nombre de tool se reescribe con MODIFIED (el nombre del requirement y de sus escenarios no cambia, así que el spec archivado conserva su historia). El requirement «Seis tools MCP sobre HTTP streamable» no puede ir en MODIFIED: su nombre y su escenario «tools/list devuelve exactamente seis» pasan a ser falsos, y renombrar dentro de MODIFIED crea un requirement nuevo y deja el viejo vivo. Va como REMOVED + ADDED con nombre propio.

## Risks / Trade-offs

- **Cache de tools de Hermes.** Hermes guarda el esquema de tools de cada servidor MCP entre sesiones; tras el cambio mostraría los nombres `kb_*` hasta refrescarlo. Mitigación: paso del orquestador al cierre (quitar y volver a registrar `cortex`, abrir sesión nueva). No es trabajo de una card.
- **Dos servidores de prueba corriendo** (puertos 3091 y 3092) sirven el código anterior desde el worktree `v1`. Se reinician desde el worktree de este change al cerrar.
- **Borrar es definitivo desde las tools.** No hay `cortex_restore`; la recuperación es manual en la base. Se acepta porque el borrado es lógico y el rastro dice qué restaurar.
