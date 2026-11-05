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

## Las skills del repo (para el agente)

El repo trae **dos** skills y un instalador, porque son dos audiencias:

| Skill | Para quién | Qué resuelve |
|---|---|---|
| `cortex-mcp` | el agente que **usa** el MCP | cuándo buscar y qué escribir, deduplicado (`similar_exists`), `base_rev`, borrado con motivo, qué nunca se guarda |
| `cortex-mcp-project` | quien **desarrolla** el servidor | migraciones con `migrate deploy`, tests contra el Postgres local, entrega por rama + PR, receta contra Neon |

¿Por qué una skill si el MCP ya trae las tools? Porque el MCP da nombres y esquemas, no la política: sin
la skill el agente tiene siete tools y ninguna regla de cuándo usarlas.

```bash
python scripts/install-skill.py                        # las dos, Hermes y Claude si existen
python scripts/install-skill.py --skills cortex-mcp     # solo la de uso del MCP
python scripts/install-skill.py --target hermes --profiles coder,reviewer
python scripts/install-skill.py --claude-project .      # además como skills de proyecto
```

Windows: `py scripts\install-skill.py` (el `~` es `%USERPROFILE%`).

Destinos: `~/.hermes/skills/<categoría>/<skill>` y `~/.claude/skills/<skill>` (más
`<repo>/.claude/skills/…` con `--claude-project`). Va como **copia**, no como symlink: el escáner de
skills de Hermes no sigue enlaces. Si editás una skill, commiteala y volvé a correr el script; el menú `/`
del desktop usa caché, así que después hace falta `/reload-skills`.

### Instalar la skill sin clonar

Sin tener el repo clonado, el instalador se baja solo y baja el árbol completo de `skills/` desde
GitHub antes de instalar:

```bash
curl -fsSL https://raw.githubusercontent.com/jastorgalj/cortex/main/scripts/install-skill.py \
  -o /tmp/install-cortex-skill.py && python /tmp/install-cortex-skill.py
```

Instala las dos skills —`cortex-mcp` y `cortex-mcp-project` **completa** (incluido su
`scripts/verify-initial-migration.sh`)— en `~/.hermes/skills/` y `~/.claude/skills/`. El comando
apunta a `main`: publicá ahí la versión que quieras distribuir. Para no tocar las skills reales al
probar, pasá `--hermes-home` y `--claude-home`.

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
| `docker compose up` (servicio `server`) | `${DATABASE_URL:-…}` en `docker-compose.yml:25`: la toma del `.env` junto al compose, del entorno del shell o, si no hay ninguna, del servicio `db` (ver [Levantar con Docker Compose](#levantar-con-docker-compose)) |
| Base local de desarrollo | servicio `db` de `docker-compose.yml`: imagen `pgvector/pgvector:pg16`, puerto host `5433` |
| Tests | **no** se toma del `.env`: `test/preload.ts` usa un Postgres local fijo (`127.0.0.1:5433`, el del compose) y `bunfig.toml` fija `[test.env] DATABASE_URL` en `cortex_test` (ver [Desarrollo](#desarrollo)) |

```bash
# ejemplo de URL (usuario, clave y base a gusto del entorno)
DATABASE_URL=postgresql://cortex:cortex_dev@127.0.0.1:5433/cortex
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
- **Los tests no tocan la base compartida.** `test/preload.ts` apunta siempre a un Postgres local
  (`cortex_test` en `127.0.0.1:5433`) y **no lee el `DATABASE_URL` del `.env`**, así que poner una URL
  remota (Neon) en el `.env` no hace que `bun test` escriba ahí: `bun test` nunca hace TRUNCATE ni
  escrituras sobre las notas reales.

## Levantar en desarrollo

Requisitos: Bun ≥ 1.4 y un **PostgreSQL 16 con `pgvector`** (o Docker para levantarlo con
`docker-compose.yml`).

```bash
docker compose up -d db
# crea un .env con DATABASE_URL apuntando a esa base (el .env no se commitea):
#   cp .env.example .env  y descomentar la opción B (127.0.0.1:5433)
bunx prisma migrate deploy
bun install
bun run dev
```

> **Aplicá migraciones con `migrate deploy`, no con `migrate dev`.** Las migraciones incluyen SQL a
> mano que el datamodel no puede expresar (índice HNSW del embedding e índice parcial de
> `deleted_at`). `migrate dev` vuelve a diffear contra el datamodel y, si le das un nombre, escribe
> una migración que **borra** esos objetos. Para una migración nueva: escribí el SQL en
> `prisma/migrations/<timestamp>_<nombre>/migration.sql` y aplicalo con `migrate deploy`.

El servidor queda en `http://localhost:3091`. Variables: `DATABASE_URL` (obligatoria), `PORT`
(por defecto 3091) y `MODEL_CACHE_DIR` (opcional: dónde se guarda el modelo ONNX; por defecto
`~/.model-cache/knowledge-mcp`). El primer arranque descarga y carga el modelo (puede tardar unos
minutos); `GET /health` reporta `model_loaded`.

## Descargar la imagen (sin clonar el repo)

La imagen está publicada en GHCR: `ghcr.io/jastorgalj/cortex`. Bajala, pasá la URL de la base y
arrancá, sin clonar el repo ni editar archivos versionados:

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

`200` con `"status":"ok"` es el servidor funcionando; `notes: 0` es lo esperado en una base recién
migrada y `model_loaded: true` confirma el modelo ONNX cargado.

> **El arranque migra la base a la que apunte `DATABASE_URL`.** Antes de servir, el contenedor
> corre `bun run db:migrate` (`prisma migrate deploy`): aplica las migraciones **pendientes** y
> nunca baja de versión (repetir el arranque es idempotente). Si `DATABASE_URL` apunta a una base
> **compartida o externa**, la migra para todos. El destino necesita **PostgreSQL 16 con pgvector**
> (extensiones `vector`, `unaccent` y `pg_trgm`). El primer arranque descarga ~420 MB del modelo
> ONNX al volumen `cortex-model-cache` (no se repite).

### Arquitectura y fallos esperados

La imagen se publica **solo para `linux/amd64`**. En un host `arm64` (Mac con Apple Silicon) el
`docker pull` funciona y el contenedor corre **emulado** —Docker Desktop lo avisa—: sirve para probar, no
para producción. Publicar `arm64` está pendiente.

Si el arranque no puede trabajar, el contenedor **sale con código ≠ 0 y lo dice** en vez de quedarse a
medias:

| Situación | Qué ves en `docker logs cortex` |
|---|---|
| Falta `DATABASE_URL` | `error: DATABASE_URL no está definida.` y el ejemplo del `-e` |
| URL inalcanzable, sin permisos o sin `pgvector` | `error: no se pudieron aplicar las migraciones.` y «Revisá DATABASE_URL: debe apuntar a un PostgreSQL 16 con pgvector accesible» |

### Publicar la imagen (paso de Juan)

La imagen se publica con un workflow de GitHub Actions que se dispara con un tag
(`git tag v0.2.0 && git push --tags`). El package de GHCR **nace privado** por defecto, incluso en
un repo público: tras el primer push del tag, hay que hacerlo público **una sola vez** para que el
`docker pull` anónimo funcione:

```bash
gh api -X PATCH /user/packages/container/cortex -f visibility=public
```

Sin ese paso, `docker pull ghcr.io/jastorgalj/cortex:latest` responde 401.

## Levantar con Docker Compose

La instalación completa, desde un checkout limpio: dos comandos y una verificación.

### Prerrequisitos

- Docker Engine con Compose: el comando `docker compose` (el plugin moderno, no el viejo
  `docker-compose`). `docker compose version` lo confirma.
- Puertos libres en el host: **`3091`** (servidor) y **`5433`** (Postgres). Si alguno está
  ocupado, cambiá el mapeo en `docker-compose.yml` (`ports:`) o usá un override.
- ~2 GB de disco para las imágenes y ~420 MB del modelo ONNX, que se descarga en el primer
  arranque y queda en el volumen `model-cache` (no se repite).

### Instalación

```bash
git clone https://github.com/jastorgalj/cortex.git cortex && cd cortex
cp .env.example .env         # opcional: sin .env se usa el Postgres del compose
docker compose up --build -d
```

`up` construye la imagen, levanta `db`, espera su healthcheck, **aplica las migraciones
pendientes** y recién entonces arranca el servidor: las migraciones corren en el **entrypoint de la
imagen** (`docker-entrypoint.sh`, `bun run db:migrate`), así que no hace falta `command:` en el
compose y un `docker run` simple queda autosuficiente. El primer arranque descarga y carga el
modelo, así que puede tardar unos minutos (el healthcheck del contenedor tiene `start_period: 300s`).
Para seguir el arranque:

```bash
docker compose logs -f server
```

### Verificar

```bash
curl http://localhost:3091/health
# -> {"status":"ok","notes":0,"model_loaded":true}
```

`200` con `"status":"ok"` es la instalación funcionando. `notes: 0` es lo esperado en una base
recién migrada, y `model_loaded: true` confirma que el modelo ONNX ya está cargado (el servidor lo
calienta antes de empezar a escuchar, así que la primera respuesta ya lo reporta así).

### Cómo se pasa la URL de la base

`DATABASE_URL` **no** está hardcodeada en el compose: el servicio `server` declara
`${DATABASE_URL:-postgresql://…@db:5432/cortex}`, así que se puede apuntar a otra base sin editar
ningún archivo versionado. Tres formas, en orden de precedencia:

| # | Forma | Cómo |
|---|---|---|
| 1 (gana) | variable del shell | `DATABASE_URL=postgresql://… docker compose up -d` (o `export` antes) |
| 2 | archivo `.env` junto al `docker-compose.yml` | `cp .env.example .env` y descomentar/editar la línea `DATABASE_URL` |
| 3 (default) | ninguna de las anteriores | el servicio `db` del compose, por la red interna (host `db`) |

El `.env` va **en la raíz del repo, al lado de `docker-compose.yml`** (compose lo busca ahí, no en
la carpeta desde donde corrés el comando). Está ignorado por git (`.gitignore`); la plantilla
versionada es `.env.example`, que trae ejemplos comentados: el `db` del compose, el mismo Postgres
desde el host (`127.0.0.1:5433`, para `bun run dev`) y una base externa con `sslmode=require`.

Para ver qué URL va a usar el compose **sin levantar nada**:

```bash
docker compose config | grep DATABASE_URL
```

> **`up` aplica las migraciones sobre la base que diga `DATABASE_URL`.** Antes de arrancar, el
> contenedor corre `bun run db:migrate` (`prisma migrate deploy`). Solo aplica migraciones
> **pendientes** y nunca baja de versión, así que repetir `up` es idempotente; pero si
> `DATABASE_URL` apunta a una base **compartida o externa** (Neon), tu `up` la migra para todos.
> Mientras desarrollás, apuntá a una base propia; antes de levantar contra la compartida revisá
> qué migraciones nuevas lleva tu checkout (`git log --oneline -- prisma/migrations`).

### Arranque con el sistema operativo

Los dos servicios (`db` y `server`) tienen `restart: unless-stopped`: si el host se reinicia,
vuelven a subir solos. Eso requiere que el daemon de Docker arranque con el sistema — en Linux con
systemd:

```bash
sudo systemctl enable --now docker
```

En macOS y Windows alcanza con activar «Start at login» de Docker Desktop (Settings → General).

El modelo se guarda en el volumen `model-cache`: recrear el contenedor no pierde notas ni
re-descarga el modelo, y `pgdata` conserva la base. Para borrar todo (base incluida):
`docker compose down -v`.

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

> **Los tests usan la base `cortex_test`, nunca `cortex` ni Neon.** `test/preload.ts` crea esa base en
> el Postgres local del compose y aplica las migraciones si no existen; la URL de test **no se deriva
> del `.env`** (se puede sobreescribir con `TEST_DATABASE_URL` en el shell si usas otro puerto). Las
> notas reales quedan intactas al correr `bun test`.

Los cambios se especifican con OpenSpec antes de implementarse: `openspec/specs/` describe el
comportamiento vigente (el contrato) y `openspec/changes/archive/` guarda el historial de
decisiones de cada cambio.

## Fuera de alcance hoy

- Restaurar una nota borrada desde las tools (el borrado es lógico: se recupera en la base).
- Autenticación y permisos por usuario.
- Captura automática de lo que ocurre en una sesión: Cortex guarda lo que alguien decide
  guardar. Otra herramienta podría alimentarlo, pero no es su función.

## Licencia

**Apache License 2.0** — ver [LICENSE](LICENSE). Copyright 2026 Juan Astorga.

Es una licencia permisiva (se puede usar, modificar y redistribuir, incluso comercialmente), con dos
cosas que la diferencian de MIT y que conviene tener claras antes de contribuir:

- **Concesión de patentes explícita** (sección 3): quien contribuye cede también sus patentes sobre
  lo aportado, y quien demande por patentes sobre el proyecto pierde la licencia.
- **Aviso de cambios y de copyright** (secciones 4 y 5): al redistribuir hay que conservar `LICENSE`,
  los avisos de copyright y —si existiera— un `NOTICE`, y marcar que se modificaron los archivos.

Las contribuciones se reciben bajo la misma licencia: quien abre un PR acepta que su aporte se
distribuya con Apache 2.0.

Las dependencias son compatibles (MIT, Apache 2.0 e ISC). El modelo de embeddings
(`all-mpnet-base-v2`) **no** se redistribuye: se descarga en tiempo de ejecución y conserva su propia
licencia.
