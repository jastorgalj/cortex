## MODIFIED Requirements

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

## ADDED Requirements

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
