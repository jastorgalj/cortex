## MODIFIED Requirements

### Requirement: Búsqueda híbrida con fusión de rankings

`cortex_search` SHALL ejecutar la búsqueda léxica (full-text de Postgres, configuración `spanish` e
insensible a tildes, sobre título y cuerpo) y la semántica (vecinos por coseno en pgvector) y
fusionar ambos rankings con Reciprocal Rank Fusion (k=60), descartando los semánticos con
score < 0.25 antes de fusionar. Cada resultado SHALL incluir id, título, snippet, score, origen
(`lexical`, `semantic` o `both`) e `issue` (el de la nota, o `null` si no tiene).

El snippet SHALL ser el fragmento del cuerpo donde matcheó el término (`ts_headline` con
`MaxWords=35,MinWords=15` sobre el cuerpo normalizado con `unaccent`, la misma normalización del
índice), no los primeros caracteres del cuerpo, y SHALL NOT contener marcadores de resaltado. Para un
resultado que solo aparece en la rama semántica —donde no hay término que destacar— el snippet SHALL
ser el inicio del cuerpo, truncado a 200 caracteres. Razón: si el término está después de los
primeros 200 caracteres, un snippet de cabecera no lo muestra y el agente tiene que leer la nota
completa para confirmar que sirve.

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

#### Scenario: El snippet muestra el término aunque esté al final del cuerpo

GIVEN una nota cuyo cuerpo tiene más de 200 caracteres de relleno y recién al final el identificador
`SNIP-7734`
WHEN se busca `SNIP-7734`
THEN el resultado de esa nota incluye un snippet que contiene `SNIP-7734` y no supera los 500
caracteres
