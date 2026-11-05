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
score < 0.25 antes de fusionar. Cada resultado SHALL incluir id, título, snippet, score y
origen (`lexical`, `semantic` o `both`).

#### Scenario: Identificador exacto lo encuentra la léxica

GIVEN una nota cuyo cuerpo contiene el identificador `CAR-359` y ninguna otra lo menciona
WHEN se busca `CAR-359`
THEN esa nota es el primer resultado y su origen incluye `lexical`

#### Scenario: Consulta conceptual en español la encuentra la semántica

GIVEN el corpus importado del equipo
WHEN se busca una formulación conceptual que no repite palabras del título (p. ej. «quién puede
modificar la tasa preferencial de un cliente»)
THEN la nota correcta aparece en el top 3 con origen que incluye `semantic`

### Requirement: El índice semántico se actualiza en la misma escritura

Crear o actualizar una nota SHALL dejar su embedding actualizado antes de responder, sin paso
de reindexado posterior. Razón: un índice que requiere reindexado manual reproduce el problema
del `bitacora build` olvidado que motivó este proyecto.

#### Scenario: Nota recién creada es encontrable de inmediato

GIVEN una `cortex_write` exitosa
WHEN se ejecuta `cortex_search` con una paráfrasis del contenido inmediatamente después
THEN la nota nueva aparece en los resultados sin ninguna operación intermedia

### Requirement: Filtros por app, kind y tags

`cortex_search` y `cortex_list` SHALL aceptar filtros opcionales por `app`, `kind` y tags libres,
que restringen los resultados a notas que cumplan todos los filtros pedidos. Razón: el corpus
mezcla sistemas distintos (cartera, huella, infraestructura) y el filtro evita el ruido
cross-dominio ya sufrido en el workspace de bitacora; `kind` permite rescates deterministas como
«todas las reglas de cartera» al armar una card.

#### Scenario: El filtro excluye otros dominios

GIVEN notas con `app: cartera` y notas con `app: huella` que comparten vocabulario
WHEN se busca con filtro `app: "cartera"`
THEN ningún resultado tiene `app: huella`

#### Scenario: Listado de reglas de una app

GIVEN notas de cartera con kinds variados
WHEN se llama `cortex_list` con `app: "cartera"` y `kind: "regla"`
THEN la respuesta contiene todas las notas con ese app y kind exactos, y ninguna otra
