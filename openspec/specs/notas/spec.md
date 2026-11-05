# notas Specification

## Purpose
Ciclo de vida de una nota de conocimiento del equipo: creación con detección de duplicados,
lectura, actualización con revisión, listado, borrado lógico, historial e importación inicial
desde el repo git anterior.

## Requirements

### Requirement: Una nota tiene autoría declarada y clasificación estructurada

Toda nota SHALL tener título, cuerpo markdown, autor no vacío, `app` no vacío, `kind` dentro
del enum {`sistema`, `flujo`, `decision`, `pitfall`, `regla`, `otro`}, tags libres y fechas;
`issue` es opcional. Una escritura con `author`, `app` o `kind` inválidos SHALL ser rechazada
indicando el campo. Razón: la clasificación libre degenera y el agente pierde el rescate
determinista (fricción medida del repo git anterior).

#### Scenario: Escritura sin autor rechazada

GIVEN una llamada `cortex_write` con título y cuerpo válidos y `author` vacío
WHEN el servidor la procesa
THEN responde error nombrando `author` como campo requerido y no crea ninguna nota

#### Scenario: kind fuera del enum rechazado

GIVEN una llamada `cortex_write` con `kind: "nota-rapida"`
WHEN el servidor la procesa
THEN responde error nombrando los valores válidos del enum y no crea ninguna nota

### Requirement: Toda actualización conserva la versión anterior

`cortex_update` SHALL insertar la versión vigente completa (título, cuerpo, tags, autor, motivo,
fecha) en `note_revisions` antes de aplicar el cambio, con número de revisión incremental.
`cortex_history` SHALL devolver las revisiones en orden. Razón: la DB reemplaza a git; sin
revisiones, un update destruye conocimiento sin rastro.

#### Scenario: Dos actualizaciones producen dos revisiones

GIVEN una nota creada y actualizada dos veces por autores distintos
WHEN se consulta `cortex_history` de esa nota
THEN devuelve 2 revisiones con rev 1 y 2, cada una con el cuerpo anterior y el autor que lo
escribió, y la nota vigente refleja la última actualización

### Requirement: Control de concurrencia optimista en la actualización

`cortex_update` SHALL aceptar `base_rev` opcional: cuando viene y no coincide con la revisión
vigente de la nota, el servidor SHALL rechazar la actualización informando la revisión actual,
sin modificar nada. Sin `base_rev` la actualización aplica (last-writer-wins) y la versión
pisada queda recuperable en el historial. Razón: dos agentes que leyeron la misma nota no deben
pisarse en silencio.

#### Scenario: Actualización con base_rev desactualizada rechazada

GIVEN una nota en revisión 2 y un agente que la leyó cuando estaba en revisión 1
WHEN ese agente llama `cortex_update` con `base_rev: 1`
THEN el servidor rechaza indicando que la revisión vigente es 2 y la nota no cambia

### Requirement: El borrado es lógico

El borrado de una nota SHALL marcar `deleted_at` sin eliminar la fila ni sus revisiones. Una
nota borrada SHALL no aparecer en `cortex_search` ni `cortex_list`, y `cortex_read` por id SHALL
indicar que está borrada. Razón: conocimiento borrado por error debe poder recuperarse.

#### Scenario: Nota borrada desaparece de los listados

GIVEN una nota existente que aparece en `cortex_list`
WHEN se borra y se vuelve a consultar `cortex_list` y `cortex_search` con términos de su título
THEN no aparece en ninguno de los dos, y `cortex_read` con su id responde indicando el borrado

### Requirement: Creación con detección de duplicados

`cortex_write` sin `force` SHALL comparar semánticamente la nota candidata contra las existentes
antes de insertar: con alguna similitud ≥ 0.55, SHALL responder `status: "similar_exists"` con
las candidatas (id, título, score) y no crear la nota; con `force: true` SHALL crearla siempre.
Razón: la deduplicación automática silenciosa del flujo anterior actualizaba archivos
equivocados — la decisión es del agente, que tiene el contexto.

#### Scenario: Nota similar existente frena la creación

GIVEN una nota existente sobre un tema y una `cortex_write` nueva cuyo contenido supera 0.55 de
similitud contra ella
WHEN el servidor la procesa sin `force`
THEN responde `similar_exists` con la nota existente entre las candidatas y el total de notas
no cambia

#### Scenario: force crea a pesar de la similitud

GIVEN la misma situación
WHEN la llamada incluye `force: true`
THEN la nota se crea y la respuesta incluye su id

### Requirement: Importación inicial idempotente desde los repos existentes

El comando de importación SHALL aceptar como fuente un clon de `novara-knowledge` o un repo
de código con `.bitacora/learnings/`, creando una nota por archivo markdown con autor e issue del
frontmatter cuando existan y un tag `origen:<repo>:<path-relativo>`, y re-ejecutarlo SHALL no
duplicar notas (idempotencia por ese tag). Razón: el sistema nace poblado o nace muerto. La
inferencia de `app`/`kind` por fuente vive en design.md Decisión 9.

#### Scenario: Segunda corrida no duplica

GIVEN un directorio fixture con 3 archivos markdown importables
WHEN el comando de importación corre dos veces contra la misma DB
THEN existen exactamente 3 notas con tag `origen:` y la segunda corrida reporta 0 creadas

#### Scenario: Learnings de un repo de código entran con su app

GIVEN un repo de código fixture llamado `backend` con 2 archivos en `.bitacora/learnings/`
WHEN el comando de importación corre contra ese repo
THEN existen 2 notas nuevas con `app` inferida de ese repo y tag `origen:backend:...`

### Requirement: El borrado por tool exige autoría y motivo

`cortex_delete` SHALL recibir `id`, `author` y `reason`, los tres no vacíos, y SHALL rechazar la
llamada nombrando el parámetro faltante sin borrar nada. Razón: borrar es la única operación que
las tools no pueden deshacer; sin autor y motivo no se puede responder quién borró una nota ni
por qué.

#### Scenario: Borrado sin autor o sin motivo rechazado

GIVEN una nota existente
WHEN se llama `cortex_delete` con `author` vacío, o con `reason` vacío
THEN responde error nombrando el parámetro faltante, la nota sigue visible en `cortex_list` y su
historial no cambia

### Requirement: El borrado deja una revisión final en el historial

Al borrar, `cortex_delete` SHALL marcar `deleted_at` y SHALL insertar en `note_revisions` una
revisión con la versión vigente de la nota (título, cuerpo, tags), el `author` del borrado y el
`reason` recibido, de modo que `cortex_history` la devuelva como última revisión. Una nota
inexistente o ya borrada SHALL rechazarse sin crear revisión. Razón: el rastro del borrado vive
en el mismo historial que el resto de los cambios, sin una tabla aparte.

#### Scenario: El borrado deja rastro en el historial

GIVEN una nota existente con 2 revisiones
WHEN `maria` la borra con `reason: "duplicada de otra nota"`
THEN `cortex_history` devuelve 3 revisiones con números 1, 2 y 3 sin repetir, la última con
`author: "maria"` y `reason: "duplicada de otra nota"` y con el cuerpo que la nota tenía al
borrarse, y la nota deja de aparecer en `cortex_list` y `cortex_search`

#### Scenario: Borrar una nota inexistente o ya borrada

GIVEN un id que no existe, o el de una nota ya borrada
WHEN se llama `cortex_delete` con ese id
THEN responde error descriptivo que nombra el id y dice que no existe o ya está borrada, y no
se crea ninguna revisión
