# Cortex

**La memoria compartida del equipo de desarrollo y de sus agentes.**

Cortex es un servidor MCP que guarda, busca y mantiene el conocimiento técnico del equipo en una sola
base de datos central, y lo deja al alcance de cualquier agente de IA (Claude Code, Hermes) y de
cualquier persona, sin pasar por git.

## ¿Qué es?

Un servidor que corre en la red interna, habla MCP por HTTP y guarda notas técnicas: cómo funciona un
sistema, por qué se decidió algo, qué trampa ya nos mordió. El agente las consulta antes de empezar
una tarea y escribe lo que aprendió al terminarla, así ese conocimiento queda en un solo lugar en vez
de repartirse entre chats, cabezas y repos.

No captura sesiones por su cuenta ni reemplaza la documentación del código: guarda lo que alguien
decide guardar, con autor y clasificación.

## Sin Cortex vs con Cortex

Sin una memoria común, cada agente y cada persona empieza de cero: el mismo pitfall se redescubre en
cada sesión, las decisiones («por qué esto es así») viven en un chat que nadie vuelve a abrir, y la
documentación se desactualiza porque actualizarla es un paso aparte que se olvida.

![Sin Cortex vs con Cortex](docs/assets/sin-vs-con-cortex.svg)

## Cómo funciona

El agente conecta por MCP y Cortex traduce cada consulta a una búsqueda híbrida sobre PostgreSQL:
palabras exactas más similitud semántica, fusionadas en un solo ranking. Todo vive en la misma base
para todo el equipo, así que no hay `pull`, ni ramas de conocimiento, ni conflictos de merge.

![Flujo agente → Cortex → PostgreSQL](docs/assets/flujo-agente-cortex-postgres.svg)

## Qué guarda

| Campo | Qué es |
|---|---|
| `title`, `body_md` | Título y contenido en Markdown |
| `app` | A qué sistema pertenece: `cartera`, `huella`, `api-scoring`, `general`, nombre del repo… Se normaliza a minúsculas y el filtro incluye siempre `general`, que es la app transversal |
| `kind` | `sistema`, `flujo`, `decision`, `pitfall`, `regla` |
| `tags` | Libres. Los que empiezan con `origen:` los reserva el importador |
| `author` | Quién la escribe. Obligatorio en `cortex_delete`; opcional en `cortex_write`/`cortex_update` (cadena de resolución: argumento > header `x-cortex-author` > nombre del cliente MCP > `agente`; un author inferido no es un author declarado). |
| `issue` | Ticket de origen, opcional (`CAR-287`, `#134`, una URL) — se puede filtrar con `cortex_list` y `cortex_search`, y corregir con `cortex_update` |

Tres reglas que hacen que la memoria no se degrade:

- **Antes de crear, avisa si ya existe algo parecido** (coseno ≥ umbral configurable, default 0.75,
  o mismo issue con título casi igual) y devuelve `similar_exists` con las candidatas. Las candidatas
  incluyen `app`, `kind`, `issue`, `matched_by` y `same_issue` para que el agente pueda decidir.
  Usar `cortex_update` sobre la candidata si es la misma idea; `force: true` con `reason` obligatorio
  para crear igual cuando se trata de una idea genuinamente distinta. El `reason` queda guardado en la
  nota y aparece en `cortex_read`, `cortex_list` y `GET /api/notes/:id`.
- **Toda actualización conserva la versión anterior**, y dos agentes no se pisan en silencio: si la
  nota cambió desde que se leyó, la escritura se rechaza e indica la revisión vigente.
- **Borrar es lógico y deja huella:** exige autor y motivo, la nota desaparece de búsquedas y
  listados, y el historial muestra quién la borró y por qué.

Dos señales más, no bloqueantes, sobre la **calidad de lo guardado** (`cortex_write` y `cortex_update`
devuelven `warnings` cuando aplican; una nota bien formada no lo trae):

- **Bitácoras.** Un título de registro de actividad (`Cierre …`, `Sesión …`, `Log …`), una referencia
  `MR !N` / `PR #N` en el título o una fecha al inicio del título o del cuerpo se advierten: Cortex
  guarda conocimiento reutilizable, no el registro de lo que pasó. Con `CORTEX_STRICT_NOTES=1` la
  escritura se rechaza (`ValidationError`) en vez de advertir.
- **Contenido que no calza con su `kind`.** `decision` sin motivo ni alternativa descartada, `pitfall`
  sin causa o sin arreglo, `flujo` sin lista de pasos: el warning incluye el esqueleto esperado
  (tomado de la descripción del tipo).

## Qué puede hacer tu agente

| Tool | Para qué |
|---|---|
| `cortex_search` | Búsqueda híbrida (léxica + semántica). Filtros opcionales por `app` (incluye `general`, salvo `include_general: false`), `kind`, `issue` y `tags` (AND) |
| `cortex_read` | Leer una nota completa por id |
| `cortex_write` | Crear una nota. Detecta duplicados (umbral 0.75 configurable); `force: true` + `reason` para crear igual |
| `cortex_update` | Actualizar una nota; puede corregir o quitar `issue` con `reason` y la revisión que se leyó, opcionales |
| `cortex_list` | Listar notas con filtros (`app` con `general` incluido, `kind`, tags, autor, `issue`) |
| `cortex_apps` | Ver qué apps existen hoy, cada una con su conteo de notas, más el vocabulario configurado |
| `cortex_history` | Historial de revisiones de una nota |
| `cortex_delete` | Borrar una nota (lógico). Exige `author` y `reason`; queda en el historial |

**Vocabulario de `app`.** `app` es texto libre normalizado a minúsculas. Para que el equipo no fragmente
el corpus, el servidor acepta un vocabulario canónico por entorno: `CORTEX_APPS=backend,console,general`,
`CORTEX_APP_ALIASES={"back":"backend"}` (un alias escribe el canónico) y `CORTEX_APP_MODE=warn|strict`
(`warn`, el default, acepta un valor desconocido y devuelve `warnings`; `strict` lo rechaza listando los
válidos). `general` es la app transversal: filtrar por cualquier app incluye sus notas salvo
`include_general: false`. `cortex_apps` (o `GET /api/apps`) muestra qué apps existen hoy con su conteo.

**Alias de argumentos.** Las tools aceptan claves equivalentes para facilitar la integración con
agentes que usan nombres distintos: `query` o `text` como alias de `q` en `cortex_search`; `body`,
`content` o `markdown` como alias de `body_md` en `cortex_write` y `cortex_update`. Si se envían
el nombre canónico y un alias con valores distintos, la tool responde `isError: true` indicando los
dos nombres en conflicto. Los alias no aparecen en `tools/list` ni alteran los campos `required`.

**`issue: null` en `cortex_write`.** Pasar `issue: null`, `""` o `"   "` guarda `null` en la nota.
Un valor no vacío se guarda tal cual.

Los errores dicen exactamente qué falta o qué id no existe, para que el agente se corrija solo. El
patrón de uso: buscar al empezar una tarea, leer lo que sirve, actualizar si la nota ya existe y
escribir solo cuando no existe.

## Empezar en dos minutos (Docker)

La imagen está publicada en GHCR y se conecta a cualquier PostgreSQL 16 con `pgvector`:

```bash
docker pull ghcr.io/jastorgalj/cortex:latest

docker run -d --name cortex -p 3091:3091 \
  -e DATABASE_URL="postgresql://usuario:clave@host:5432/cortex" \
  -e CORTEX_DUPLICATE_THRESHOLD=0.75 \
  -v cortex-model-cache:/app/.model-cache \
  --restart unless-stopped \
  ghcr.io/jastorgalj/cortex:latest
```

Verificación:

```bash
curl http://localhost:3091/health
# -> {"status":"ok","notes":0,"model_loaded":true}
```

`status: ok` es el servidor funcionando, `notes: 0` es lo esperado en una base recién migrada y
`model_loaded: true` confirma el modelo de embeddings cargado. El contenedor aplica las migraciones
pendientes al arrancar, así que el `docker run` queda autosuficiente.

Si la base es administrada (Neon, RDS), agregá `?sslmode=require` a la URL: esos proveedores exigen TLS.

¿No tenés un Postgres a mano? El repo trae un compose con base incluida — ver
[CONTRIBUTING.md](CONTRIBUTING.md).

> **Nota de seguridad.** El servidor **no trae autenticación**: la autoría es declarativa (`author` en
> cada escritura). Va en red interna o VPN. Si lo exponés fuera de ahí, poné un proxy con auth delante.

**Primer arranque.** La primera vez descarga ~420 MB del modelo ONNX y puede tardar varios minutos (el
healthcheck espera hasta 300s). `model_loaded: true` es la señal de que ya sirve; desde ahí el modelo
queda en el volumen y no se vuelve a descargar.

**Arquitectura.** La imagen se publica solo para `linux/amd64`. En un host `arm64` (Mac con Apple
Silicon) funciona, pero corre emulada: sirve para probar, no para producción.

## Conectar tu agente

**Hermes** registra el servidor con su CLI y lo descubre al iniciar la sesión:

```bash
hermes mcp add cortex --url http://localhost:3091/mcp
hermes mcp test cortex        # debe listar las 8 tools
```

Las tools aparecen como `mcp__cortex__cortex_search`, `mcp__cortex__cortex_write`, etc. Si cambian los
esquemas, quitá el servidor y volvé a agregarlo para que refresque el cache.

**Claude Code** habla HTTP streamable directamente:

```bash
claude mcp add --transport http cortex http://localhost:3091/mcp
claude mcp list               # debe mostrar cortex conectado
```

Para todo el equipo, versioná un `.mcp.json` en la raíz del repo:

```json
{
  "mcpServers": {
    "cortex": {
      "type": "http",
      "url": "http://localhost:3091/mcp"
    }
  }
}
```

**Las skills del repo** le dan al agente la política que el MCP no trae: cuándo buscar, qué escribir y
cómo no duplicar. Se instalan sin clonar nada:

```bash
curl -fsSL https://raw.githubusercontent.com/jastorgalj/cortex/main/scripts/install-skill.py \
  -o /tmp/install-cortex-skill.py && python /tmp/install-cortex-skill.py
```

Instala `cortex-mcp` (para el agente que usa el MCP) y `cortex-mcp-project` (para quien desarrolla el
servidor) en `~/.hermes/skills/` y `~/.claude/skills/`.

## API de lectura

Además de MCP, el servidor expone una API REST de solo lectura para personas y scripts:

```bash
curl "http://localhost:3091/api/search?q=tasa+especial&app=cartera&limit=5"
curl "http://localhost:3091/api/search?q=tasa+especial&app=cartera&include_general=false"
curl "http://localhost:3091/api/apps"
curl "http://localhost:3091/api/notes/<id>"
curl http://localhost:3091/health
```

`GET /` muestra la lista de notas en HTML. Las escrituras pasan **solo** por `/mcp`: cualquier
POST/PUT/PATCH/DELETE en `/api` responde 405, así que la validación, la deduplicación y el historial
de revisiones no se pueden saltar.

## Si el contenedor aparece `unhealthy`

El healthcheck de Compose (`docker-compose.yml`) y del `Dockerfile` pide `200` con `status: "ok"` en
`GET /health`. Cuando la base de datos no responde, el servidor responde **503** con
`{"status":"degraded","db":"down","error":"base de datos no disponible"}` (el mensaje real queda en el
log del servidor, nunca en el cuerpo) y el contenedor pasa a `unhealthy`. Qué significa y qué hacer:

1. **`unhealthy` no reinicia nada.** `restart: always` o `unless-stopped` solo relanzan el proceso si
   muere; un contenedor `unhealthy` sigue corriendo. No hace falta reiniciarlo para que se recupere.
2. **La causa más común es la base**, no el servidor: Postgres caído, una pausa de red o el pool de
   conexiones agotado. Revisá `docker logs <contenedor>`: el `[cortex] health probe error` dice el
   motivo real.
3. **Cuando la base vuelve, el servidor se recupera solo** (Prisma reabre las conexiones) y `/health`
   vuelve a `200` en menos de un minuto, sin reiniciar el contenedor. Si no vuelve, ahí sí `docker
   restart`.
4. **`/health` tiene timeout propio (3 s) y un solo sondeo compartido.** Con la base colgada responde
   `503` rápido en vez de quedarse esperando, y decenas de requests simultáneas no agotan el pool.
   Los reintentos de las tools no aplican a `/health`: este endpoint nunca reintenta, contesta de
   inmediato. `MCP_SESSION_TTL_MINUTES` (opcional, 1440 por defecto) controla cuánto dura una sesión
   MCP inactiva antes de que el barrido la cierre.

## Licencia

**Apache License 2.0** — ver [LICENSE](LICENSE). Se puede usar, modificar y redistribuir, incluso
comercialmente; las contribuciones se reciben bajo la misma licencia.

## Cooperar con el desarrollo

Clonar el repo, correr los tests, escribir migraciones, importar conocimiento existente, publicar la
imagen o entender cómo se serializan las escrituras concurrentes: todo eso vive en
[CONTRIBUTING.md](CONTRIBUTING.md).
