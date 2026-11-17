# busqueda Specification

## Purpose
Búsqueda híbrida sobre las notas: léxica (full-text de Postgres en español) para
identificadores exactos y semántica
(embeddings locales) para conceptos en lenguaje natural, fusionadas en un solo ranking.

## Requirements

### Requirement: Búsqueda híbrida con fusión de rankings

`cortex_search` SHALL ejecutar la búsqueda léxica (full-text de Postgres, configuración `spanish` e
insensible a tildes, sobre título y cuerpo) y la semántica (vecinos por coseno en pgvector) y
fusionar ambos rankings con Reciprocal Rank Fusion (k=60), descartando los semánticos con
score < 0.25 antes de fusionar. Cada resultado SHALL incluir id, título, snippet, score, origen
(`lexical`, `semantic` o `both`) e `issue` (el de la nota, o `null` si no tiene).

#### Scenario: Identificador exacto lo encuentra la léxica

GIVEN una nota cuyo cuerpo contiene el identificador `CAR-359` y ninguna otra lo menciona
WHEN se busca `CAR-359`
THEN esa nota es el primer resultado y su origen incluye `lexical`

#### Scenario: Consulta conceptual en español la encuentra la semántica

GIVEN el corpus importado del equipo
WHEN se busca una formulación conceptual que no repite palabras del título (p. ej. «quién puede
modificar la tasa preferencial de un cliente»)
THEN la nota correcta aparece en el top 3 con origen que incluye `semantic`

#### Scenario: El resultado expone el issue de la nota

GIVEN una nota con `issue: "ABC-1"` y otra sin `issue`, ambas encontrables con la misma búsqueda
WHEN se ejecuta `cortex_search`
THEN el resultado de la primera trae `issue: "ABC-1"` y el de la segunda trae `issue: null`

### Requirement: El índice semántico se actualiza en la misma escritura

Crear o actualizar una nota SHALL dejar su embedding actualizado antes de responder, sin paso
de reindexado posterior. Razón: un índice que requiere reindexado manual reproduce el problema
del `bitacora build` olvidado que motivó este proyecto.

#### Scenario: Nota recién creada es encontrable de inmediato

GIVEN una `cortex_write` exitosa
WHEN se ejecuta `cortex_search` con una paráfrasis del contenido inmediatamente después
THEN la nota nueva aparece en los resultados sin ninguna operación intermedia

### Requirement: Filtros por app, kind y tags

`cortex_search` y `cortex_list` SHALL aceptar filtros opcionales por `app`, `kind` y `tags`, que
restringen los resultados a notas que cumplan todos los filtros pedidos. `tags` SHALL ser una lista y
la nota SHALL tener todos los tags pedidos (AND), cada uno por igualdad exacta; una lista vacía no
filtra. Razón: el corpus mezcla sistemas distintos y el filtro evita el ruido cross-dominio; `kind`
permite rescates deterministas como «todas las reglas de cartera».

#### Scenario: El filtro excluye otros dominios

GIVEN notas con `app: cartera` y notas con `app: huella` que comparten vocabulario
WHEN se busca con filtro `app: "cartera"`
THEN ningún resultado tiene `app: huella`

#### Scenario: Listado de reglas de una app

GIVEN notas de cartera con kinds variados
WHEN se llama `cortex_list` con `app: "cartera"` y `kind: "regla"`
THEN la respuesta contiene todas las notas con ese app y kind exactos, y ninguna otra

#### Scenario: La búsqueda por tags exige todos los tags

GIVEN una nota A con tags `["area:x", "repo:y"]`, una nota B con tags `["area:x"]` y una nota C sin tags,
las tres encontrables con la misma búsqueda
WHEN se ejecuta `cortex_search` con `tags: ["area:x", "repo:y"]`
THEN el resultado contiene la nota A y no contiene B ni C

#### Scenario: Un solo tag basta para restringir

GIVEN las mismas notas A, B y C
WHEN se ejecuta `cortex_search` con `tags: ["area:x"]`
THEN el resultado contiene A y B y no contiene C

#### Scenario: Una lista de tags vacía no filtra

GIVEN las mismas notas A, B y C
WHEN se ejecuta `cortex_search` con `tags: []`
THEN el resultado contiene las tres notas, igual que sin el parámetro

### Requirement: Los filtros restringen ambas ramas de la búsqueda

Todo filtro de `cortex_search` (`app`, `kind`, `issue`, `tags`) SHALL aplicarse en la consulta léxica y
en la semántica antes de limitar el número de candidatos, de modo que ninguna nota que no cumpla el
filtro llegue a la fusión por ninguna de las dos ramas. Razón: un filtro aplicado solo a una rama deja
colar notas de otro dominio por la otra.

#### Scenario: Una nota fuera del filtro no entra por la rama semántica

GIVEN una nota con tag `area:x` y otra sin ese tag, ambas con un cuerpo casi idéntico para que la rama
semántica las considere vecinas
WHEN se ejecuta `cortex_search` con `tags: ["area:x"]` y una consulta conceptual sin palabras exactas del
título
THEN la nota sin el tag no aparece, ni con origen `semantic` ni con origen `both`

### Requirement: Filtro por issue

`cortex_list` y `cortex_search` SHALL aceptar un filtro opcional `issue` que restringe los resultados a
las notas cuyo `issue` es igual al pedido, sin distinguir mayúsculas ni espacios en los extremos de
ninguno de los dos valores. La comparación SHALL ser de igualdad exacta: `MTD-38` no coincide con
`MTD-380`. Razón: los agentes trabajan por ticket y necesitan todo lo conocido de uno.

#### Scenario: El listado por issue ignora las mayúsculas

GIVEN notas con `issue: "ABC-1"`, `issue: "ABC-2"` y sin `issue`
WHEN se llama `cortex_list` con `issue: "abc-1"`
THEN la respuesta contiene solo las notas de `ABC-1`

#### Scenario: Los espacios en los extremos no importan

GIVEN una nota con `issue: " ABC-1 "` guardado con espacios y otra con `issue: "ABC-1"`
WHEN se llama `cortex_list` con `issue: "  ABC-1"`
THEN la respuesta contiene ambas notas

#### Scenario: Igualdad exacta, no prefijo

GIVEN notas con `issue: "MTD-38"` y con `issue: "MTD-380"`
WHEN se llama `cortex_list` con `issue: "MTD-38"`
THEN la respuesta contiene solo la nota de `MTD-38`

#### Scenario: La búsqueda por issue restringe ambas ramas

GIVEN una nota con `issue: "ABC-1"` y otra con `issue: "ABC-2"`, ambas con un cuerpo casi idéntico
WHEN se ejecuta `cortex_search` con `issue: "ABC-1"` y una consulta que ambas satisfacen
THEN el resultado contiene la nota de `ABC-1` y no la de `ABC-2`, ya sea la consulta léxica o conceptual

#### Scenario: Los filtros se combinan

GIVEN una nota con `issue: "ABC-1"` y tag `area:x`, y otra con `issue: "ABC-1"` sin ese tag
WHEN se llama `cortex_list` con `issue: "ABC-1"` y `tags: ["area:x"]`
THEN la respuesta contiene solo la primera nota

### Requirement: Un issue en blanco no filtra

Un filtro `issue` vacío o de solo espacios SHALL tratarse como ausente, igual que `app`, `kind` y
`author` vacíos. Razón: la regla es la misma para todos los filtros de texto.

#### Scenario: Un issue en blanco no filtra

GIVEN notas con distintos `issue`
WHEN se llama `cortex_list` con `issue: "   "`
THEN la respuesta es la misma que sin el parámetro

### Requirement: Índice para el filtro por issue

La tabla `notes` SHALL tener un índice llamado `notes_issue_idx` sobre la expresión
`lower(btrim(issue))`, creado por una migración SQL nueva, y el filtro por `issue` SHALL usar esa misma
expresión para que el planner pueda aprovecharlo. Razón: el filtro es la consulta más frecuente por
ticket y, con filtro selectivo, el índice evita que el planner recorra el índice vectorial y filtre
después.

#### Scenario: La migración crea el índice

GIVEN una base vacía
WHEN se aplican las migraciones con `prisma migrate deploy`
THEN `pg_indexes` contiene `notes_issue_idx` sobre `notes` con la expresión `lower(btrim(issue))`

#### Scenario: La consulta del filtro usa el índice

GIVEN la base de test con el índice y `SET enable_seqscan = off`
WHEN se hace `EXPLAIN` de la consulta que produce el filtro por `issue`
THEN el plan contiene `notes_issue_idx`
