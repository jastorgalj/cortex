# Cortex

**La memoria compartida del equipo de desarrollo y de sus agentes.**

Cortex es un servidor MCP que guarda, busca y mantiene el conocimiento técnico del equipo
(cómo funciona un sistema, por qué se decidió algo, qué trampa ya nos mordió) en **una sola base
de datos central**, y lo deja al alcance de cualquier agente de IA (Claude Code, Hermes) y de
cualquier persona, sin pasar por git.

## Para qué sirve

Un agente que empieza una tarea no sabe lo que el equipo ya aprendió. Sin una memoria común:

- el mismo pitfall se redescubre en cada sesión y en cada persona;
- las decisiones («por qué esto es así») viven en la cabeza de quien las tomó o en un chat;
- la documentación se desactualiza porque actualizarla es un paso aparte que se olvida.

Cortex resuelve eso con tres ideas:

1. **Una fuente de verdad, sin sincronización.** Todos los agentes leen y escriben el mismo
   servidor. No hay `pull`, ni ramas de conocimiento, ni conflictos de merge: el flujo anterior
   (un repo git de conocimiento sincronizado por hooks) chocaba con el flujo git del equipo, y por
   eso se reemplazó.
2. **Curado, no automático.** Cada nota tiene autor, `app` y `kind`: alguien decide qué vale la
   pena recordar y lo clasifica. Eso permite rescates deterministas («todas las reglas de
   cartera») en vez de depender solo de la similitud.
3. **Búsqueda que entiende el significado.** Combina búsqueda por palabras exactas (un
   identificador como `CAR-359`) con búsqueda semántica (preguntas en lenguaje natural), así que
   «¿quién puede modificar la tasa preferencial de un cliente?» encuentra la nota correcta aunque no
   repita las palabras del título.

## Qué es una nota

| Campo | Qué es |
|---|---|
| `title`, `body_md` | Título y contenido en Markdown |
| `app` | A qué sistema pertenece: `cartera`, `huella`, `api-scoring`, `general`, nombre del repo… |
| `kind` | `sistema`, `flujo`, `decision`, `pitfall`, `regla` u `otro` |
| `tags` | Libres. Los que empiezan con `origen:` los reserva el importador |
| `author` | Quién la escribe. **Obligatorio** en toda escritura |
| `issue` | Ticket de origen, opcional (`CAR-287`, `#134`, una URL) |

Reglas del modelo, pensadas para agentes:

- **Antes de crear, el servidor avisa si ya existe algo parecido** (similitud ≥ 0.55) y responde
  `similar_exists` con las candidatas. El agente decide: actualizar la existente o crear igual
  con `force: true`. El servidor nunca fusiona por su cuenta.
- **Toda actualización conserva la versión anterior** en un historial. Nada se pisa sin rastro.
- **Dos agentes no se pisan en silencio:** `cortex_update` acepta `base_rev`; si la nota cambió
  desde que se leyó, el servidor rechaza e indica la revisión vigente.
- **Borrar es lógico y deja huella:** `cortex_delete` exige `author` y `reason`; la nota
  desaparece de búsquedas y listados, pero el historial muestra quién la borró y por qué.

## Las siete tools MCP

| Tool | Para qué |
|---|---|
| `cortex_search` | Búsqueda híbrida (léxica + semántica). Filtros opcionales por `app`, `kind` y tags |
| `cortex_read` | Leer una nota completa por id |
| `cortex_write` | Crear una nota. Detecta duplicados; `force: true` para crear igual |
| `cortex_update` | Actualizar una nota, con `reason` y `base_rev` opcionales |
| `cortex_list` | Listar notas con filtros (`app`, `kind`, tags, autor) |
| `cortex_history` | Historial de revisiones de una nota |
| `cortex_delete` | Borrar una nota (lógico). Exige `author` y `reason`; queda en el historial |

Los errores dicen exactamente qué falta o qué id no existe, para que el agente se corrija solo.

## Cómo lo usa un agente

El patrón de uso, en orden:

```
Empiezo una tarea en <app>      → cortex_search (y cortex_list con kind=regla para las reglas de esa app)
Encontré algo útil              → cortex_read para leerlo completo
Aprendí algo que el equipo debe saber
   ¿ya existe una nota?         → cortex_update (con reason, y base_rev si la leí antes)
   ¿no existe?                  → cortex_write (author + app + kind)
Una nota está mal o sobra       → cortex_delete (author + reason)
```

Qué merece una nota: una decisión y su porqué, un pitfall con su causa y su arreglo, un flujo que
no se deduce del código. Qué no: lo que ya está claro en el código o en el historial de git.

## Integración con Hermes

Hermes guarda los servidores MCP en su config y los descubre al iniciar la sesión. Se registra
con su CLI (el agente no puede editar `config.yaml` directamente):

```bash
hermes mcp add cortex --url http://localhost:3091/mcp
# "¿Requiere autenticación?"  → n   (el servidor vive en red interna, ver «Sin auth»)
# "¿Habilitar las 7 tools?"   → Y
hermes mcp test cortex        # debe listar las 7 tools
```

Luego abre una sesión nueva o ejecuta `/reload-mcp`. Las tools aparecen como
`mcp__cortex__cortex_search`, `mcp__cortex__cortex_write`, etc.

**Si cambia el servidor** (por ejemplo, nombres de tools nuevos), Hermes puede seguir mostrando
el esquema anterior desde su cache. Quita y vuelve a registrar el servidor:

```bash
hermes mcp remove cortex
hermes mcp add cortex --url http://localhost:3091/mcp
```

Para que los agentes de la fábrica lo usen, enséñales el patrón de la sección anterior en la skill
o en el `AGENTS.md` del repo donde trabajan.

## Integración con Claude Code

Claude Code habla HTTP streamable directamente. Dos formas:

**Por comando** (queda en tu configuración de usuario o de proyecto):

```bash
claude mcp add --transport http cortex http://localhost:3091/mcp
claude mcp list               # debe mostrar cortex conectado
```

**Por archivo, para todo el equipo** (`.mcp.json` en la raíz de un repo, versionable):

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

Las tools aparecen como `mcp__cortex__cortex_search`, etc. Para que Claude las use sin que se lo
pidas cada vez, agrega al `CLAUDE.md` (o `AGENTS.md`) del repo algo como:

```markdown
## Conocimiento del equipo (Cortex)
- Antes de empezar una tarea, busca con `cortex_search` y filtra por la `app` del repo.
- Al descubrir un pitfall o tomar una decisión que el equipo debe conocer, escríbela con
  `cortex_write` (author = tu nombre, app = esta app, kind = pitfall|decision|regla|flujo|sistema).
- Si ya existe una nota sobre eso, actualízala con `cortex_update` en vez de crear otra.
```

### Clientes que solo hablan stdio

Si algún cliente no soporta HTTP streamable, un puente lo resuelve:

```json
{
  "mcpServers": {
    "cortex": {
      "command": "npx",
      "args": ["-y", "mcp-proxy", "--target", "http://localhost:3091/mcp"]
    }
  }
}
```

## Cómo está hecho

```
        Agentes (Hermes, Claude Code)
              |  MCP (HTTP streamable)
        +------------+
        |  /mcp      |  <- 7 tools cortex_*
        |  Elysia    |
        |  + Bun     |
        |  /api      |  <- GET /api/search  GET /api/notes/:id   (solo lectura)
        |  /         |  <- Vista web para personas (solo lectura)
        |  /health   |  <- Healthcheck
        +------------+
              |  Prisma
        +------------+
        |  Postgres  |  pgvector (vector 768) + búsqueda de texto en español
        +------------+
```

- **Stack:** TypeScript, Bun, Elysia, Prisma, PostgreSQL 16 con pgvector.
- **Embeddings locales:** modelo ONNX `all-mpnet-base-v2` corriendo dentro del servidor. Sin API
  key ni costo por consulta. El primer arranque descarga ~420 MB (se guarda y no se repite).
- **Búsqueda:** texto completo de Postgres en español (insensible a tildes) + similitud por
  coseno, fusionados con Reciprocal Rank Fusion.
- **Un solo punto de escritura:** solo `/mcp` escribe. La API REST y la vista web son de lectura,
  para que la validación, las revisiones y la deduplicación no se puedan saltar.
- **Provider-agnóstico y propia del proyecto:** la base se define con `DATABASE_URL` y no se
  comparte con otros sistemas. Hoy corre sobre Neon (free tier); migrar a otro Postgres es
  `pg_dump | pg_restore` + cambiar esa variable (el destino necesita la extensión `vector`).

### Dónde se configura la base

Cortex **necesita PostgreSQL 16 con `pgvector`**: no hay otra persistencia ni caché de notas en
disco. La conexión se define en un solo lugar lógico —la variable `DATABASE_URL`— y cambia según el
contexto:

| Contexto | Dónde se define |
|---|---|
| Servidor (`bun run dev`, producción) | variable de entorno `DATABASE_URL` del proceso; en local Prisma la lee del `.env` de la raíz (ignorado por git) |
| `docker compose up` (servicio `server`) | `environment.DATABASE_URL` en `docker-compose.yml`, apuntando al servicio `db` |
| Base local de desarrollo | servicio `db` de `docker-compose.yml`: imagen `pgvector/pgvector:pg16`, puerto host `5433` |
| Tests | `bunfig.toml` → `[test.env] DATABASE_URL`, apuntando a `cortex_test` (ver [Desarrollo](#desarrollo)) |

```bash
# ejemplo de URL (usuario, clave y base a gusto del entorno)
DATABASE_URL=postgresql://cortex:knowledge_dev@127.0.0.1:5433/cortex
```

La migración inicial habilita `vector`, `unaccent` y `pg_trgm` (`CREATE EXTENSION IF NOT EXISTS`),
así que el único requisito del Postgres destino es **traer esas extensiones instaladas**: imagen
`pgvector/pgvector`, paquete `postgresql-16-pgvector` en Debian/Arch, o la extensión habilitada en
el proveedor administrado (Neon ya la trae).

## Base compartida: escrituras concurrentes

La base es **una sola y compartida** por todo el equipo y sus agentes, así que el CRUD está pensado
para que dos escrituras simultáneas no se pisen ni se pierdan datos:

- **Un solo punto de escritura.** Solo el endpoint `/mcp` escribe; la API REST y la vista web son de
  lectura (POST/PUT/PATCH/DELETE responden 404/405). Toda escritura pasa por la misma validación,
  deduplicación y registro de revisiones.
- **Ids ULID generados en el cliente** (`src/db/ulid.ts`): sin secuencias ni coordinación entre
  procesos, y ordenables por tiempo.
- **Bloqueo de fila antes de escribir.** `updateNote` abre una transacción y hace
  `SELECT … FOR UPDATE` sobre la nota (`src/db/notes.ts:273`), así que dos updates de la misma nota
  se serializan.
- **Revisión optimista (`base_rev`).** Si el llamador leyó la nota en `rev: 1` y alguien más ya la
  dejó en `rev: 2`, el servidor **rechaza con `ConflictError`** e informa la revisión vigente
  (`src/db/notes.ts:282`) en vez de sobreescribir. La tool devuelve el conflicto al agente, que debe
  releer y reintentar; sin `base_rev` gana el último en escribir (last-writer-wins declarado).
- **Revisiones append-only.** Cada update inserta la versión anterior en `note_revisions` **en la
  misma transacción** (`src/db/notes.ts:290`): nunca queda un estado intermedio ni un historial
  huérfano.
- **Borrado lógico.** `cortex_delete` marca `deleted_at` y exige `author` + `reason`; no hay
  `DELETE` físico, así que un borrado no rompe referencias ni revisiones.
- **Deduplicación que avisa, no bloquea.** Antes de crear, el servidor responde `similar_exists`
  con las candidatas (similitud ≥ `DUPLICATE_THRESHOLD`, 0.55); crear igual requiere `force: true`.
  No hay locks de “nombre único” ni fusiones automáticas: dos agentes pueden crear notas parecidas y
  el humano decide.
- **Los tests no tocan la base compartida.** `bunfig.toml` inyecta un `DATABASE_URL` de test y
  `test/preload.ts` crea y migra `cortex_test` antes de correr: `bun test` nunca hace TRUNCATE ni
  escrituras sobre las notas reales.

## Levantar en desarrollo

Requisitos: Bun ≥ 1.4 y un **PostgreSQL 16 con `pgvector`** (o Docker para levantarlo con
`docker-compose.yml`).

```bash
docker compose up -d db
# crea un .env con DATABASE_URL apuntando a esa base (el .env no se commitea)
bunx prisma migrate deploy
bun install
bun run dev
```

El servidor queda en `http://localhost:3091`. Variables: `DATABASE_URL` (obligatoria), `PORT`
(por defecto 3091) y `MODEL_CACHE_DIR` (opcional: dónde se guarda el modelo ONNX; por defecto
`~/.model-cache/knowledge-mcp`). El primer arranque descarga y carga el modelo (puede tardar unos
minutos); `GET /health` reporta `model_loaded`.

## Levantar con Docker Compose

```bash
docker compose up --build -d
```

El modelo se guarda en el volumen `model-cache`: recrear el contenedor no pierde notas ni
re-descarga el modelo, porque la base vive fuera del servidor.

## API REST de solo lectura

```bash
curl "http://localhost:3091/api/search?q=tasa+especial&app=cartera&limit=5"
curl "http://localhost:3091/api/notes/<id>"
curl "http://localhost:3091/health"
# -> {"status":"ok","notes":<n>,"model_loaded":true}
```

POST/PUT/PATCH/DELETE fuera de `/mcp` responden 404/405.

## Importar conocimiento existente

```bash
# (a) Desde el repo de conocimiento anterior:
bun run import -- /srv/repos/novara-knowledge

# (b) Desde repos de código que tengan .bitacora/learnings/:
bun run import -- /srv/repos/nucleo-core/backend
bun run import -- /srv/repos/nucleo-core/frontend
```

Es idempotente: volver a correrlo no duplica (cada nota lleva un tag `origen:<repo>:<ruta>`).

## Sin auth (decisión consciente)

El servidor vive en red interna / VPN y no pide credenciales; la autoría es declarativa (`author`
en cada escritura). Con 5-10 personas de confianza, un esquema de tokens cuesta más de lo que
protege. **Si el servidor sale de la VPN o el equipo crece, auth es el primer cambio.**

La `DATABASE_URL` nunca se commitea (`.env` está ignorado por git).

## Desarrollo

```bash
bun test                 # suite completa
bun run typecheck        # tsc --noEmit
```

> **Los tests usan la base `cortex_test`, nunca `cortex` ni Neon.** `bunfig.toml`
> inyecta un `DATABASE_URL` separado y `test/preload.ts` crea esa base y aplica las migraciones
> si no existen. Las notas reales quedan intactas al correr `bun test`.

Los cambios se especifican con OpenSpec antes de implementarse: `openspec/specs/` describe el
comportamiento vigente (el contrato) y `openspec/changes/archive/` guarda el historial de
decisiones de cada cambio.

## Fuera de alcance hoy

- Restaurar una nota borrada desde las tools (el borrado es lógico: se recupera en la base).
- Autenticación y permisos por usuario.
- Captura automática de lo que ocurre en una sesión: Cortex guarda lo que alguien decide
  guardar. Otra herramienta podría alimentarlo, pero no es su función.
