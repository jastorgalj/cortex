## MODIFIED Requirements

### Requirement: Toda actualización conserva la versión anterior

`cortex_update` SHALL insertar la versión vigente completa (título, cuerpo, tags, autor, motivo,
fecha) en `note_revisions` antes de aplicar el cambio, con número de revisión incremental.
`cortex_history` SHALL devolver las revisiones en orden de `rev` ascendente; sus cuerpos se piden
con `include_body` o `rev` (requirements siguientes). Razón: la DB reemplaza a git; sin
revisiones, un update destruye conocimiento sin rastro.

#### Scenario: Dos actualizaciones producen dos revisiones

GIVEN una nota creada y actualizada dos veces por autores distintos
WHEN se consulta `cortex_history` de esa nota con `include_body: true`
THEN `items` contiene 2 revisiones con rev 1 y 2, cada una con el cuerpo anterior y el autor que lo
escribió, y la nota vigente refleja la última actualización

### Requirement: El borrado deja una revisión final en el historial

Al borrar, `cortex_delete` SHALL marcar `deleted_at`, SHALL insertar en `note_revisions` una revisión
con la versión vigente de la nota (título, cuerpo, tags) y SHALL avanzar la revisión de la nota en uno.
La revisión final SHALL conservar el `author` del contenido y SHALL registrar en el `reason` quién
borró, junto al motivo recibido. Una nota inexistente o ya borrada SHALL rechazarse sin crear revisión.

#### Scenario: El borrado deja rastro en el historial

GIVEN una nota en revisión 3 con dos revisiones previas, cuyo contenido vigente fue escrito por `beto`
WHEN `maria` la borra con `reason: "duplicada de otra nota"`
THEN `cortex_history` con `include_body: true` devuelve en `items` 3 revisiones numeradas 1, 2 y 3 sin
repetir, la última con `author: "beto"`, con un `reason` que incluye `"duplicada de otra nota"` y el
nombre de `maria`, y con el cuerpo que la nota tenía al borrarse, y la nota deja de aparecer en
`cortex_list` y `cortex_search`

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

## ADDED Requirements

### Requirement: El historial responde total e items sin cuerpos

`cortex_history` SHALL responder `{ "total": N, "items": [...] }`, donde `total` es el número de
revisiones guardadas de la nota y cada ítem trae `note_id`, `rev`, `title`, `tags`, `author`, `reason` y
`created_at`, y no trae `body_md`. Un id sin revisiones o inexistente SHALL responder `total: 0` e
`items: []`. Razón: cada revisión repite la nota entera; medido, el historial de una nota de 30 mil
caracteres con 4 revisiones pesa 104.754 caracteres.

#### Scenario: Historial por defecto sin cuerpos

GIVEN una nota creada y actualizada dos veces
WHEN se llama `cortex_history` solo con el `id`
THEN `total` es 2, `items` tiene 2 elementos con `note_id`, `rev`, `title`, `tags`, `author`, `reason` y
`created_at`, y ningún elemento tiene la clave `body_md`

#### Scenario: Nota sin revisiones

GIVEN una nota recién creada y nunca actualizada
WHEN se llama `cortex_history`
THEN responde `total: 0` e `items: []`

### Requirement: El historial trae los cuerpos solo si se piden

Con `include_body: true`, cada ítem de `cortex_history` SHALL traer además `body_md` con el cuerpo de esa
revisión; sin él, ningún ítem lo trae. Razón: el agente que necesita el texto lo pide; el que solo quiere
saber quién cambió qué no paga por él.

#### Scenario: include_body trae los cuerpos

GIVEN una nota con 2 revisiones
WHEN se llama `cortex_history` con `include_body: true`
THEN cada elemento de `items` trae `body_md` con el cuerpo que tenía esa revisión

### Requirement: El historial entrega una revisión puntual con su cuerpo

Con `rev: N` (entero ≥ 1), `cortex_history` SHALL responder `items` con solo la revisión N, incluido su
`body_md`, y `total` con el número de revisiones guardadas; `rev` SHALL prevalecer sobre `limit` e
`include_body`. Si la nota no tiene guardada la revisión N, SHALL responder error que nombra el id y N y
dice que la versión vigente se lee con `cortex_read`. Razón: el agente ve los metadatos y pide solo el
cuerpo que le interesa.

#### Scenario: rev trae el cuerpo de esa revisión

GIVEN una nota creada con el cuerpo «uno» y actualizada dos veces (cuerpos «dos» y «tres»)
WHEN se llama `cortex_history` con `rev: 1`
THEN `items` tiene un solo elemento con `rev: 1` y `body_md` igual a «uno», y `total` es 2

#### Scenario: rev de la versión vigente

GIVEN la misma nota, que está en revisión 3 con 2 revisiones guardadas
WHEN se llama `cortex_history` con `rev: 3`
THEN responde error que empieza con `Error en cortex_history`, nombra el id y el número 3 y menciona
`cortex_read`

### Requirement: El historial devuelve las revisiones más recientes

`cortex_history` SHALL aceptar `limit` (entero entre 1 y 100, defecto 10) y SHALL devolver las `limit`
revisiones de mayor `rev`, ordenadas por `rev` ascendente; `total` SHALL contar todas las guardadas.
Razón: una nota muy editada no debe volcar su historia completa por defecto.

#### Scenario: Más revisiones que el límite

GIVEN una nota con 12 revisiones guardadas
WHEN se llama `cortex_history` sin `limit`
THEN `total` es 12 e `items` tiene 10 elementos con `rev` 3 a 12 en ese orden

#### Scenario: limit mayor trae todas

GIVEN la misma nota con 12 revisiones guardadas
WHEN se llama `cortex_history` con `limit: 12`
THEN `items` tiene 12 elementos con `rev` 1 a 12

#### Scenario: limit fuera de rango rechazado

GIVEN una nota con revisiones
WHEN se llama `cortex_history` con `limit: 0`, con `limit: 101` o con `rev: 0`
THEN cada llamada responde error y el mensaje nombra el parámetro inválido
