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
| `app` | A qué sistema pertenece: `cartera`, `huella`, `api-scoring`, `general`, nombre del repo… |
| `kind` | `sistema`, `flujo`, `decision`, `pitfall`, `regla` |
| `tags` | Libres. Los que empiezan con `origen:` los reserva el importador |
| `author` | Quién la escribe. **Obligatorio** en toda escritura |
| `issue` | Ticket de origen, opcional (`CAR-287`, `#134`, una URL) |

Tres reglas que hacen que la memoria no se degrade:

- **Antes de crear, avisa si ya existe algo parecido** (similitud ≥ 0.55) y devuelve `similar_exists`
  con las candidatas. El agente decide si actualiza la existente o crea igual con `force: true`; el
  servidor nunca fusiona por su cuenta.
- **Toda actualización conserva la versión anterior**, y dos agentes no se pisan en silencio: si la
  nota cambió desde que se leyó, la escritura se rechaza e indica la revisión vigente.
- **Borrar es lógico y deja huella:** exige autor y motivo, la nota desaparece de búsquedas y
  listados, y el historial muestra quién la borró y por qué.

## Qué puede hacer tu agente

| Tool | Para qué |
|---|---|
| `cortex_search` | Búsqueda híbrida (léxica + semántica). Filtros opcionales por `app`, `kind` y tags |
| `cortex_read` | Leer una nota completa por id |
| `cortex_write` | Crear una nota. Detecta duplicados; `force: true` para crear igual |
| `cortex_update` | Actualizar una nota, con `reason` y la revisión que se leyó, opcionales |
| `cortex_list` | Listar notas con filtros (`app`, `kind`, tags, autor) |
| `cortex_history` | Historial de revisiones de una nota |
| `cortex_delete` | Borrar una nota (lógico). Exige `author` y `reason`; queda en el historial |

Los errores dicen exactamente qué falta o qué id no existe, para que el agente se corrija solo. El
patrón de uso: buscar al empezar una tarea, leer lo que sirve, actualizar si la nota ya existe y
escribir solo cuando no existe.

## Empezar en dos minutos (Docker)

La imagen está publicada en GHCR y se conecta a cualquier PostgreSQL 16 con `pgvector`:

```bash
docker pull ghcr.io/jastorgalj/cortex:latest

docker run -d --name cortex -p 3091:3091 \
  -e DATABASE_URL="postgresql://usuario:clave@host:5432/cortex" \
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
hermes mcp test cortex        # debe listar las 7 tools
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
curl "http://localhost:3091/api/notes/<id>"
curl http://localhost:3091/health
```

`GET /` muestra la lista de notas en HTML. Las escrituras pasan **solo** por `/mcp`: cualquier
POST/PUT/PATCH/DELETE en `/api` responde 405, así que la validación, la deduplicación y el historial
de revisiones no se pueden saltar.

## Licencia

**Apache License 2.0** — ver [LICENSE](LICENSE). Se puede usar, modificar y redistribuir, incluso
comercialmente; las contribuciones se reciben bajo la misma licencia.

## Cooperar con el desarrollo

Clonar el repo, correr los tests, escribir migraciones, importar conocimiento existente, publicar la
imagen o entender cómo se serializan las escrituras concurrentes: todo eso vive en
[CONTRIBUTING.md](CONTRIBUTING.md).
