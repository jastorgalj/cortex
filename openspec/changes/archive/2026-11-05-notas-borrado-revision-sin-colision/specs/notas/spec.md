## MODIFIED Requirements

### Requirement: El borrado deja una revisión final en el historial

Al borrar, `cortex_delete` SHALL marcar `deleted_at`, SHALL insertar en `note_revisions` una revisión
con la versión vigente de la nota (título, cuerpo, tags) y SHALL avanzar la revisión de la nota en uno.
La revisión final SHALL conservar el `author` del contenido y SHALL registrar en el `reason` quién
borró, junto al motivo recibido. Una nota inexistente o ya borrada SHALL rechazarse sin crear revisión.

#### Scenario: El borrado deja rastro en el historial

GIVEN una nota en revisión 3 con dos revisiones previas, cuyo contenido vigente fue escrito por `beto`
WHEN `maria` la borra con `reason: "duplicada de otra nota"`
THEN `cortex_history` devuelve 3 revisiones numeradas 1, 2 y 3 sin repetir, la última con
`author: "beto"`, con un `reason` que incluye `"duplicada de otra nota"` y el nombre de `maria`, y con el
cuerpo que la nota tenía al borrarse, y la nota deja de aparecer en `cortex_list` y `cortex_search`

#### Scenario: Borrar una nota inexistente o ya borrada

GIVEN un id que no existe, o el de una nota ya borrada
WHEN se llama `cortex_delete` con ese id
THEN responde error descriptivo que nombra el id y dice que no existe o ya está borrada, y no se crea
ninguna revisión

#### Scenario: El borrado avanza la revisión de la nota

GIVEN una nota en revisión 3
WHEN se borra
THEN `cortex_read` de su id responde indicando el borrado con `rev: 4`, y ninguna revisión de
`cortex_history` usa el número 4
