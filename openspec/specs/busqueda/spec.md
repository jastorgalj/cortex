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

GIVEN notas de cartera con kinds variados, de las que 3 son `regla`
WHEN se llama `cortex_list` con `app: "cartera"` y `kind: "regla"`
THEN `items` contiene esas 3 notas y ninguna otra, y `total` es 3

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

### Requirement: La búsqueda por `app` incluye `general` y expone la app del resultado

`cortex_search` y `GET /api/search` con `app` SHALL filtrar las dos ramas (léxica y semántica) por esa app
y por `general`, salvo `include_general: false` (en REST, `include_general=false`). Cada resultado SHALL
incluir su `app` junto a `id`, `title`, `snippet`, `score`, `origin` e `issue`. Razón: el mismo criterio
que el listado, y el agente distingue de qué app vino cada nota sin un `cortex_read` extra.

#### Scenario: la búsqueda encuentra la nota de `general`

GIVEN una nota con `app: "general"` y otra con `app: "backend"` que mencionan «custodia de garantías»
WHEN se llama `cortex_search` con `q: "custodia de garantías"` y `app: "backend"`
THEN el resultado incluye las dos notas y cada una trae su `app`

#### Scenario: include_general false en la búsqueda

GIVEN las mismas dos notas
WHEN se llama `cortex_search` con `app: "backend"` e `include_general: false`
THEN el resultado no incluye la nota con `app: "general"` y las devueltas tienen `app: "backend"`

#### Scenario: REST con include_general=false

GIVEN las mismas dos notas
WHEN se llama `GET /api/search?q=custodia&app=backend&include_general=false`
THEN la respuesta no incluye la nota con `app: "general"`

### Requirement: cortex_list acepta limit y offset

`cortex_list` SHALL aceptar `limit` (entero entre 1 y 200, defecto 50) y `offset` (entero ≥ 0, defecto 0) y
SHALL devolver a lo más `limit` notas a partir de la posición `offset`. Razón: sin tope, la respuesta
crece con el corpus.

#### Scenario: Sin argumentos devuelve a lo más 50

GIVEN 60 notas no borradas
WHEN se llama `cortex_list` sin argumentos
THEN `items` tiene 50 notas, `total` es 60 y `next_offset` es 50

#### Scenario: Parámetros fuera de rango rechazados

GIVEN notas existentes
WHEN se llama `cortex_list` con `limit: 0`, con `limit: 201` o con `offset: -1`
THEN cada llamada responde error y el mensaje nombra el parámetro inválido

### Requirement: cortex_list responde total, items y next_offset

`cortex_list` SHALL responder `{ "total": N, "items": [...], "next_offset": M }`: `total` es el número de
notas no borradas que cumplen los filtros, `items` son las notas de la página con los campos de siempre
salvo `body_md` (incluidos `issue` y `force_reason`), y `next_offset` es `offset` más los ítems devueltos,
o `null` si no quedan más. Donde otros requirements hablan de lo que `cortex_list` devuelve, las notas se
leen en `items`. Razón: un arreglo pelado no puede decir que hay más páginas.

#### Scenario: Última página

GIVEN 60 notas no borradas
WHEN se llama `cortex_list` con `offset: 50`
THEN `items` tiene 10 notas, `total` es 60 y `next_offset` es `null`

#### Scenario: Offset más allá del final

GIVEN 3 notas no borradas
WHEN se llama `cortex_list` con `offset: 10`
THEN `items` es `[]`, `total` es 3 y `next_offset` es `null`

#### Scenario: Cada ítem conserva sus campos

GIVEN una nota con `issue: "ABC-1"` y `force_reason: "es otra decisión, no un duplicado"`
WHEN se llama `cortex_list`
THEN su ítem trae `id`, `title`, `app`, `kind`, `tags`, `author`, `issue`, `rev`, `force_reason`,
`created_at`, `updated_at` y `deleted_at` con esos valores, y no trae `body_md`

### Requirement: Las páginas recorren las notas sin repetir ni omitir

Las páginas consecutivas de `cortex_list` (cada una con el `next_offset` de la anterior) SHALL cubrir cada
nota que cumple los filtros exactamente una vez, ordenadas por `updated_at` descendente y, ante empate,
por `id` descendente, mientras ninguna nota cambie entre llamadas. Razón: sin desempate, dos notas con el
mismo `updated_at` pueden repetirse u omitirse entre páginas.

#### Scenario: Tres páginas de 25

GIVEN 60 notas no borradas
WHEN se llama `cortex_list` con `limit: 25` y `offset` 0, 25 y 50
THEN las páginas traen 25, 25 y 10 notas, y los 60 ids son distintos

#### Scenario: Empate de updated_at

GIVEN 4 notas con exactamente el mismo `updated_at`
WHEN se llama `cortex_list` con `limit: 2` en `offset` 0 y 2
THEN los 4 ids aparecen una vez cada uno, en orden de `id` descendente

### Requirement: Los filtros se aplican antes de contar y paginar

`total` e `items` de `cortex_list` SHALL reflejar solo las notas que cumplen `app`, `kind`, `tags`, `author`
e `issue`, incluido el filtro de `tags`, evaluado en la consulta y no sobre la página leída. Razón: un
filtro aplicado después de cortar la página da páginas cortas y un `total` falso.

#### Scenario: Tags con más notas que el límite

GIVEN 60 notas no borradas, 30 de ellas con el tag `area:x` repartidas entre las más recientes y las más
antiguas
WHEN se llama `cortex_list` con `tags: ["area:x"]` y `limit: 20`
THEN `total` es 30, `items` tiene 20 notas, todas con el tag `area:x`, y `next_offset` es 20

#### Scenario: Una lista de tags vacía no filtra el listado

GIVEN 5 notas no borradas, ninguna con tags
WHEN se llama `cortex_list` con `tags: []`
THEN `total` es 5 e `items` tiene 5 notas

### Requirement: El snippet léxico muestra el fragmento que coincide

En `cortex_search`, el `snippet` de un resultado de origen `lexical` o `both` SHALL ser el fragmento del
cuerpo donde aparece la coincidencia, calculado con `ts_headline` (configuración `spanish`, entre 15 y 35
palabras, sin marcas de resaltado) sobre el cuerpo sin tildes. Razón: el término que hizo coincidir la
nota debe verse en el resultado aunque esté lejos del inicio.

#### Scenario: Un término tardío aparece en el snippet

GIVEN una nota cuyo cuerpo menciona `zafirotasa` por primera vez después del carácter 600
WHEN se busca `zafirotasa`
THEN el snippet de esa nota contiene `zafirotasa`

#### Scenario: Un término con tilde aparece en el snippet

GIVEN una nota cuyo cuerpo menciona `conciliación` (en minúscula) por primera vez después del carácter 600
WHEN se busca `conciliación`
THEN el snippet de esa nota contiene `conciliacion`

### Requirement: Los snippets están acotados

El `snippet` de léxicos y `both` SHALL tener a lo más 400 caracteres, cortado con `…` si se pasa; el de un
resultado de origen `semantic` SHALL ser el inicio del cuerpo, de a lo más 200 caracteres, con `…` si se
corta. Razón: una palabra sin espacios de miles de caracteres no debe volver entera como snippet.

#### Scenario: El snippet nunca pasa de 400 caracteres

GIVEN una nota cuyo cuerpo es `zafirotasa ` seguido de 2000 letras `x` sin espacios
WHEN se busca `zafirotasa`
THEN el snippet de esa nota tiene a lo más 401 caracteres (400 más `…`)

#### Scenario: Un resultado solo semántico conserva el inicio del cuerpo

GIVEN un resultado cuyo origen es `semantic` y cuyo cuerpo supera 200 caracteres
WHEN se ejecuta `cortex_search`
THEN su snippet son los primeros 200 caracteres del cuerpo seguidos de `…`
