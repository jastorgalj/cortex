# Design — taxonomía de `app`

## D1. La configuración manda: vocabulario por entorno, no enum en la BD

`app` se guarda como `String` y sigue así. Un enum en Postgres obligaría a una migración por cada app
nueva y bloquearía el alta de un producto en medio de un sprint. El vocabulario vive en `CORTEX_APPS`
(entorno del servidor) y se lee en cada llamada: cambiar la lista es reiniciar el contenedor, no migrar.
Sin `CORTEX_APPS` el comportamiento es el de hoy (texto libre normalizado) — el default no rompe
instalaciones existentes.

## D2. `warn` por defecto, `strict` como opción

Modo `warn`: el valor desconocido se guarda y la respuesta trae `warnings`. Razón: perder una nota por una
app mal escrita es peor que tenerla con un valor imperfecto; el agente ve el aviso y corrige con
`cortex_update`. Modo `strict` existe para equipos que prefieren el rechazo inmediato con la lista de
valores válidos.

## D3. Los alias resuelven historia, no reescriben datos

`CORTEX_APP_ALIASES` traduce en el borde (`{"back":"backend"}`): la escritura con `back` persiste
`backend`, y un filtro `app: "back"` busca `backend`. Ninguna migración de datos: las notas viejas se
corrigen cuando alguien las edita, y los filtros ya las encuentran.

## D4. `general` es transversal, y el filtro lo dice

Filtrar por `app: "backend"` devuelve las notas de `backend` **y** las de `general`, porque las reglas y
convenciones transversales aplican a cualquier sistema — es el caso que motivó el issue. La inclusión es
explícita en el schema (`include_general`, default `true`) y cada resultado de búsqueda lleva su `app`,
así que el agente distingue de dónde vino cada nota. `include_general: false` recupera el filtro exacto.

## D5. Descubrimiento antes que adivinanza

`cortex_apps` (MCP) y `GET /api/apps` devuelven `{ app, count }` de las notas vigentes más el vocabulario
configurado. El agente ve qué valores existen antes de inventar uno, y el equipo ve dónde está el corpus
fragmentado sin consultar la BD.

## D6. Los filtros no rechazan

Un filtro no escribe nada: normaliza y resuelve alias, pero no aplica `strict`. Rechazar una búsqueda por
un valor fuera del vocabulario no protege ningún dato y sí rompe la exploración.
