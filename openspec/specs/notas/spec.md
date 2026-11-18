# notas Specification

## Purpose
Ciclo de vida de una nota de conocimiento del equipo: creación con detección de duplicados,
lectura, actualización con revisión, listado, borrado lógico, historial e importación inicial
desde el repo git anterior.

## Requirements

### Requirement: Una nota tiene autoría declarada y clasificación estructurada

Toda nota SHALL tener título, cuerpo markdown, autor no vacío, `app` no vacío, `kind` dentro
del enum cerrado de cinco tipos —`sistema`, `flujo`, `decision`, `pitfall`, `regla`—, tags
libres y fechas; `issue` es opcional. Una escritura con `author`, `app` o `kind` inválidos SHALL
ser rechazada indicando el campo. Razón: la clasificación libre degenera y el agente pierde el
rescate determinista (fricción medida del repo git anterior).

#### Scenario: Escritura sin autor rechazada

GIVEN una llamada `cortex_write` con título y cuerpo válidos y `author` vacío
WHEN el servidor la procesa
THEN responde error nombrando `author` como campo requerido y no crea ninguna nota

#### Scenario: kind fuera del enum rechazado

GIVEN una llamada `cortex_write` con `kind: "nota-rapida"` o `kind: "otro"`
WHEN el servidor la procesa
THEN responde error nombrando los valores válidos del enum y no crea ninguna nota

#### Scenario: kind 'otro' rechazado

GIVEN una llamada `cortex_write` con `kind: "otro"` y el resto de los campos válidos
WHEN el servidor la procesa
THEN responde error nombrando los cinco valores válidos (sin `otro`) y no crea ninguna nota

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

`cortex_write` sin `force` SHALL comparar la nota candidata contra las existentes antes de insertar; si alguna cumple el criterio de duplicado (requirements siguientes) SHALL responder `status: "similar_exists"` con las candidatas y no crear la nota. Con `force: true` y `reason` SHALL crearla siempre. Razón: la deduplicación automática silenciosa del flujo anterior actualizaba archivos equivocados — la decisión es del agente, que tiene el contexto.

#### Scenario: Nota similar existente frena la creación

GIVEN una nota existente sobre un tema y una `cortex_write` nueva, de la misma `app` y el mismo `kind` y sin `issue`, cuyo coseno contra ella es mayor o igual al umbral vigente
WHEN el servidor la procesa sin `force`
THEN responde `similar_exists` con la nota existente entre las candidatas y el total de notas
no cambia

#### Scenario: force crea a pesar de la similitud

GIVEN la misma situación
WHEN la llamada incluye `force: true` y un `reason` no vacío
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

### Requirement: La actualización puede corregir la clasificación

`cortex_update` SHALL aceptar `app` y `kind` opcionales para corregir la clasificación de una nota
existente sin borrarla ni perder su historial de revisiones; `kind` SHALL validarse contra el enum
cerrado de cinco tipos y `app` SHALL ser no vacío, rechazando con `ValidationError` el campo inválido.
Razón: una nota con `kind` o `app` equivocados no debería obligar a borrar y reescribir, lo que pierde
el historial y cambia el id.

#### Scenario: Corregir el kind conserva el historial

GIVEN una nota existente en revisión 1 con `kind: "pitfall"`
WHEN se llama `cortex_update` con `kind: "regla"` y `author` válido
THEN la nota queda con `kind: "regla"` y revisión 2, y `cortex_history` conserva la revisión 1

#### Scenario: kind inválido en la actualización rechazado

GIVEN una nota existente
WHEN se llama `cortex_update` con `kind: "otro"`
THEN responde error nombrando los valores válidos y la nota no cambia

### Requirement: La actualización puede corregir o quitar el issue

`cortex_update` SHALL aceptar `issue` opcional: un texto lo reemplaza (guardado sin espacios en los
extremos), `null` lo quita, y omitirlo lo deja como está. La actualización SHALL seguir el mismo camino
que las demás: inserta la revisión de la versión vigente y avanza `rev` en uno. Razón: un `issue` mal
escrito no debería obligar a borrar y reescribir, lo que pierde el historial y cambia el id.

#### Scenario: Corregir el issue

GIVEN una nota en revisión 1 con `issue: "ABC-1"`
WHEN se llama `cortex_update` con `issue: "ABC-2"` y `author` válido
THEN la nota queda con `issue: "ABC-2"` y `rev: 2`, `cortex_history` conserva la revisión 1, y
`cortex_list` con `issue: "ABC-2"` la incluye y con `issue: "ABC-1"` no

#### Scenario: Quitar el issue con null

GIVEN una nota con `issue: "ABC-1"`
WHEN se llama `cortex_update` con `issue: null` y `author` válido
THEN la nota queda con `issue: null` y ya no aparece en `cortex_list` con `issue: "ABC-1"`

#### Scenario: Omitir issue no lo cambia

GIVEN una nota con `issue: "ABC-1"`
WHEN se llama `cortex_update` con solo `title` nuevo y `author` válido
THEN la nota conserva `issue: "ABC-1"`

### Requirement: El issue vacío se rechaza en la actualización

`cortex_update` SHALL rechazar un `issue` vacío o de solo espacios con `ValidationError` sobre el campo
`issue`, indicando que se use `null` para quitarlo, sin modificar la nota ni crear revisión. Razón: «sin
issue» tiene una sola representación (`null`); aceptar `""` dejaría dos.

#### Scenario: issue vacío rechazado

GIVEN una nota con `issue: "ABC-1"` en revisión 1
WHEN se llama `cortex_update` con `issue: ""`, o con `issue: "   "`
THEN responde error que nombra `issue` e indica usar `null` para quitarlo, la nota conserva
`issue: "ABC-1"` y `rev: 1`, y `cortex_history` no gana revisiones

### Requirement: El umbral de similitud es configurable

El umbral de coseno SHALL tomarse de la variable de entorno `CORTEX_DUPLICATE_THRESHOLD`, un número mayor que 0 y menor o igual que 1; ausente o vacía, SHALL valer 0.75. El servidor SHALL leerla en cada escritura y SHALL negarse a arrancar con un valor inválido, con un mensaje que nombre la variable y el valor recibido. Razón: ajustar la sensibilidad no debe exigir recompilar ni publicar imagen.

#### Scenario: Sin variable el umbral es 0.75

GIVEN `CORTEX_DUPLICATE_THRESHOLD` ausente
WHEN se resuelve el umbral
THEN vale 0.75

#### Scenario: La variable cambia el umbral sin reiniciar el código

GIVEN dos notas de igual `app` y `kind`, sin `issue`, con coseno c
WHEN se escribe la segunda sin `force` con `CORTEX_DUPLICATE_THRESHOLD` igual a c + 0.02
THEN se crea; con `CORTEX_DUPLICATE_THRESHOLD` igual a c − 0.02 y el mismo par, responde `similar_exists`

#### Scenario: Valor inválido impide arrancar

GIVEN `CORTEX_DUPLICATE_THRESHOLD` con `abc`, `0`, `1.5` o `0,75`
WHEN el servidor arranca
THEN termina con código distinto de cero y un mensaje que nombra `CORTEX_DUPLICATE_THRESHOLD` y el valor recibido, antes de cargar el modelo

### Requirement: Distinto kind o distinto issue exigen más coseno

Una nota existente SHALL ser candidata si su coseno es mayor o igual al umbral, o mayor o igual al umbral más 0.1 cuando difiere el `kind` o difieren los `issue` (ambos no nulos, comparados sin mayúsculas y sin espacios en los extremos); el aumento es de 0.1 una sola vez aunque difieran ambos, y un `issue` nulo en cualquiera de las dos notas no activa la regla de issue. Razón: notas de tipo o ticket distinto comparten vocabulario del módulo sin ser duplicadas.

#### Scenario: Distinto kind exige más coseno

GIVEN una nota `sistema` y una nota nueva `decision`, sin `issue`, con coseno c y umbral c − 0.02
WHEN se escribe la nueva sin `force`
THEN se crea; con el mismo texto y `kind: "sistema"` responde `similar_exists`

#### Scenario: Distinto issue exige más coseno

GIVEN dos notas del mismo `kind` con `issue` `MTD-390` y `MTD-391`, con coseno c y umbral c − 0.02
WHEN se escribe la segunda sin `force`
THEN se crea; con `issue: "mtd-390 "` (mismo issue sin caja ni espacios) responde `similar_exists` con `same_issue: true` y `matched_by: "coseno"`

### Requirement: Mismo issue y título casi igual marcan duplicado

Una nota existente con el mismo `issue` no nulo que la nueva SHALL ser candidata, sea cual sea su coseno, si la similitud de título de `pg_trgm` (comparada sin tildes) es mayor o igual a 0.6. Razón: dos notas del mismo ticket con título casi idéntico suelen ser la misma nota con otra redacción.

#### Scenario: Mismo issue y título casi igual marca duplicado aunque el coseno sea bajo

GIVEN una nota con `issue` `MTD-390` y título `MTD-390: decisión sobre el cálculo de la cuota mínima`, y una nota nueva con el mismo `issue` y título `MTD-390: decisión del cálculo de la cuota mínima (QA)` cuyo coseno es menor que el umbral
WHEN se escribe la nueva sin `force`
THEN responde `similar_exists` con la existente, `same_issue: true` y `matched_by: "issue_y_titulo"`

#### Scenario: Mismo issue con títulos distintos no marca por metadatos

GIVEN una nota con `issue` `MTD-390` y título `MTD-390: decisión sobre el cálculo de la cuota mínima`, y una nota nueva con el mismo `issue` y título `MTD-390: cierre del ticket y orden de despliegue` cuyo coseno es menor que el umbral
WHEN se escribe la nueva sin `force`
THEN se crea

### Requirement: Las candidatas traen los metadatos para decidir

Cada candidata de `similar_exists` SHALL incluir `id`, `title`, `score` (coseno), `app`, `kind`, `issue` (`null` si no tiene), `updated_at`, `same_issue`, `same_kind` y `matched_by`, con `same_issue` verdadero solo si ambos `issue` son no nulos e iguales, y `matched_by` igual a `"coseno"` o a `"issue_y_titulo"`. Razón: el agente decide si actualiza o crea sin un `cortex_read` extra.

#### Scenario: La candidata incluye app, kind, issue y las banderas

GIVEN una nota existente con `app` `cartera`, `kind` `regla` y sin `issue`, y una escritura nueva con `kind` `decision` e `issue` `CAR-1` que la marca como duplicado
WHEN responde `similar_exists`
THEN la candidata trae `app: "cartera"`, `kind: "regla"`, `issue: null`, `same_issue: false`, `same_kind: false`, `updated_at` y `matched_by: "coseno"`

### Requirement: force exige un motivo

`cortex_write` con `force: true` SHALL exigir `reason`, texto no vacío tras quitar espacios; sin él SHALL rechazar la llamada nombrando `reason` y sin crear la nota. Razón: sin motivo no se puede auditar cuántos `force` fueron legítimos.

#### Scenario: force sin reason es rechazado

GIVEN una llamada `cortex_write` válida con `force: true` y sin `reason`, o con `reason: "   "`
WHEN el servidor la procesa
THEN responde error que nombra `reason` y el total de notas no cambia

### Requirement: El motivo de force queda consultable

Con `force: true` y motivo, `cortex_write` SHALL guardarlo recortado en la columna `notes.force_reason`, y `cortex_read`, `cortex_list` y `GET /api/notes/:id` SHALL devolverlo como `force_reason`. Una nota creada sin `force` SHALL tener `force_reason: null` y un `reason` enviado sin `force` SHALL ignorarse.

#### Scenario: force con reason deja el motivo consultable

GIVEN una llamada `cortex_write` con `force: true` y `reason: "  es otra decisión, no un duplicado  "`
WHEN se crea la nota y se consulta con `cortex_read`
THEN la respuesta trae `force_reason: "es otra decisión, no un duplicado"` y `cortex_list` la muestra con ese mismo valor

#### Scenario: Sin force no hay motivo guardado

GIVEN una llamada `cortex_write` sin `force` y con `reason: "x"`
WHEN se crea la nota
THEN `force_reason` es `null`

#### Scenario: El importador declara su motivo

GIVEN un directorio fixture con un archivo markdown importable
WHEN el comando de importación crea la nota
THEN la nota tiene `force_reason` no vacío que contiene el tag `origen:` de su fuente

### Requirement: La creación normaliza issue null o vacío

`cortex_write` SHALL aceptar `issue` omitido, `null`, vacío o de solo espacios y guardar `issue` como `NULL` en los cuatro casos; un `issue` con texto SHALL guardarse como llegó. La detección de duplicados SHALL tratar esos cuatro casos como «sin issue». Razón: «sin issue» tiene una sola representación (`NULL`); guardar `""` dejaría dos.

#### Scenario: issue null en la creación

GIVEN un cliente MCP conectado
WHEN se llama `cortex_write` con `issue: null` y el resto válido
THEN la nota se crea con `issue: null`

#### Scenario: issue vacío o en blanco en la creación

GIVEN un cliente MCP conectado
WHEN se llama `cortex_write` con `issue: ""` y otra con `issue: "   "` (títulos y contenidos distintos, ambas con `force: true` y `reason: "prueba de issue vacío"`)
THEN la respuesta de cada llamada y el `cortex_read` de cada id muestran `issue: null`

#### Scenario: issue con texto no cambia

GIVEN un cliente MCP conectado
WHEN se llama `cortex_write` con `issue: "ABC-1"`
THEN la nota queda con `issue: "ABC-1"` y `cortex_list` con `issue: "abc-1"` la incluye

#### Scenario: issue null no rompe el aviso de duplicado

GIVEN una nota existente sin issue
WHEN se llama `cortex_write` con `issue: null` y el mismo título y cuerpo, sin `force`
THEN responde `status: "similar_exists"` con esa nota entre las candidatas

### Requirement: La escritura normaliza `app` y valida el vocabulario configurado

`cortex_write` y `cortex_update` SHALL normalizar `app` (trim y minúsculas), resolver alias y persistir el
valor canónico. Con `CORTEX_APPS`, un valor fuera del vocabulario SHALL aceptarse con `warnings` en modo
`warn` (default) y rechazarse con `ValidationError` que liste los válidos en modo `strict`. Sin
`CORTEX_APPS` SHALL aceptarse cualquier valor no vacío, y `general` SHALL ser siempre válido. Razón: lo
persistido tiene que ser lo que se filtra, sin migrar datos.

#### Scenario: un alias se persiste como su valor canónico

GIVEN `CORTEX_APPS: "backend,general"` y `CORTEX_APP_ALIASES: {"back":"backend"}`
WHEN se llama `cortex_write` con `app: "Back"`
THEN la nota queda con `app: "backend"` y la respuesta no trae `warnings`

#### Scenario: un valor desconocido en modo warn se acepta con aviso

GIVEN `CORTEX_APPS: "backend,general"` y `CORTEX_APP_MODE: "warn"`
WHEN se llama `cortex_write` con `app: "inventada"`
THEN la nota se crea con `app: "inventada"` y la respuesta trae un `warnings` que nombra los valores válidos

#### Scenario: un valor desconocido en modo strict se rechaza

GIVEN `CORTEX_APPS: "backend,general"` y `CORTEX_APP_MODE: "strict"`
WHEN se llama `cortex_write` con `app: "inventada"`
THEN responde error de parámetro inválido `app` y la nota no se crea

#### Scenario: sin vocabulario se acepta cualquier app normalizada

GIVEN un servidor sin `CORTEX_APPS`
WHEN se llama `cortex_write` con `app: "  Backend "`
THEN la nota queda con `app: "backend"`

#### Scenario: `general` es válido con vocabulario en modo strict

GIVEN `CORTEX_APPS: "backend"` y `CORTEX_APP_MODE: "strict"`
WHEN se llama `cortex_write` con `app: "general"`
THEN la nota se crea con `app: "general"`

### Requirement: Los listados por `app` incluyen `general`

`cortex_list` con `app` SHALL devolver las notas de esa app y las de `general`, salvo con
`include_general: false`, que SHALL devolver solo la app pedida. El filtro SHALL normalizar y resolver
alias sin rechazar valores, y cada nota del listado SHALL mostrar su `app`. Razón: las reglas y
convenciones transversales viven en `general`; excluirlas hace creer que no existen.

#### Scenario: una regla de `general` aparece al filtrar por otra app

GIVEN una nota con `app: "general"` y `kind: "regla"` y otra con `app: "backend"` y `kind: "regla"`
WHEN se llama `cortex_list` con `app: "backend"` y `kind: "regla"`
THEN el resultado incluye las dos notas, cada una con su `app`

#### Scenario: include_general false devuelve solo la app pedida

GIVEN las mismas dos notas
WHEN se llama `cortex_list` con `app: "backend"`, `kind: "regla"` e `include_general: false`
THEN el resultado trae solo la nota con `app: "backend"`

#### Scenario: el filtro acepta mayúsculas y alias

GIVEN una nota con `app: "backend"`
WHEN se llama `cortex_list` con `app: "BACK"` y `CORTEX_APP_ALIASES` mapea `back` a `backend`
THEN el resultado la incluye

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
