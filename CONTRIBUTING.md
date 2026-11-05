# Contribuir a Cortex

`README.md` cuenta qué es Cortex y cómo se usa con Docker. Acá está todo lo que hace falta para
tocarlo: levantar el servidor en local, correr los tests, escribir migraciones, importar conocimiento,
entender cómo se serializan las escrituras concurrentes y publicar la imagen.

## Desarrollo local

Requisitos: Bun (probado con 1.3.14) y un **PostgreSQL 16 con `pgvector`** (o Docker para levantar el del repo con
`docker-compose.yml`).

```bash
git clone https://github.com/jastorgalj/cortex.git cortex && cd cortex
docker compose up -d db
cp .env.example .env          # descomentar la opción B (127.0.0.1:5433)
bun install
bunx prisma migrate deploy
bun run dev                   # http://localhost:3091
```

Variables: `DATABASE_URL` (obligatoria), `PORT` (por defecto 3091) y `MODEL_CACHE_DIR` (opcional: dónde
se guarda el modelo ONNX; por defecto `~/.model-cache/knowledge-mcp`). El primer arranque descarga y
carga el modelo (puede tardar unos minutos) y `GET /health` reporta `model_loaded`.

> **Aplicá migraciones con `migrate deploy`, no con `migrate dev`.** Las migraciones incluyen SQL a mano
> que el datamodel no puede expresar (índice HNSW del embedding e índice parcial de `deleted_at`).
> `migrate dev` vuelve a diffear contra el datamodel y, si le das un nombre, escribe una migración que
> **borra** esos objetos. Para una migración nueva: escribí el SQL en
> `prisma/migrations/<timestamp>_<nombre>/migration.sql` y aplicalo con `migrate deploy`.

### Tests

```bash
bun test                 # suite completa
bun run typecheck        # tsc --noEmit
```

> **Los tests usan la base `cortex_test`, nunca `cortex` ni Neon.** `test/preload.ts` crea esa base en el
> Postgres local del compose y aplica las migraciones si no existen; la URL de test **no se deriva del
> `.env`** (se puede sobreescribir con `TEST_DATABASE_URL` en el shell si usás otro puerto). Las notas
> reales quedan intactas al correr `bun test`.

## Instalación con Docker Compose (base incluida)

El compose del repo levanta el servidor con su propio Postgres, sin escribir el `docker run` a mano:

```bash
git clone https://github.com/jastorgalj/cortex.git cortex && cd cortex
docker compose up --build -d
curl http://localhost:3091/health
# -> {"status":"ok","notes":0,"model_loaded":true}
```

El `.env` es opcional: sin él, el servicio `server` apunta al `db` del compose. Para usar otra base, poné
`DATABASE_URL` en el shell o en el `.env` junto al compose — la precedencia (variable del shell > `.env` >
default del compose) está en «Configuración de la base».

> **`up` corre `prisma migrate deploy` sobre la base que diga `DATABASE_URL`**, así que si apunta a la base
> compartida la migra para todos. Ver la nota de «Configuración de la base» antes de levantar contra ella.

## OpenSpec

Los cambios se especifican antes de implementarse: `openspec/specs/` describe el comportamiento vigente
—el contrato— y `openspec/changes/archive/` guarda el historial de decisiones de cada cambio. Un cambio
nuevo se escribe en `openspec/changes/<slug>/` (proposal, design, tasks) y se valida con
`openspec validate <slug> --type change --strict` antes de tocar código.

## Arquitectura y concurrencia

- **Stack:** TypeScript, Bun, Elysia, Prisma, PostgreSQL 16 con pgvector.
- **Embeddings locales:** modelo ONNX `all-mpnet-base-v2` corriendo dentro del servidor. Sin API key ni
  costo por consulta. El primer arranque descarga ~420 MB (se guarda y no se repite).
- **Búsqueda:** texto completo de Postgres en español (insensible a tildes) + similitud por coseno,
  fusionados con Reciprocal Rank Fusion.
- **Un solo punto de escritura:** solo `/mcp` escribe. La API REST y la vista web son de lectura
  (POST/PUT/PATCH/DELETE responden 405), para que la validación, las revisiones y la deduplicación no se
  puedan saltar.
- **Provider-agnóstico:** la base se define con `DATABASE_URL` y no se comparte con otros sistemas.
  Migrar a otro Postgres es `pg_dump | pg_restore` + cambiar esa variable (el destino necesita la
  extensión `vector`).

La base es **una sola y compartida** por todo el equipo y sus agentes, así que el CRUD está pensado para
que dos escrituras simultáneas no se pisen:

- **Ids ULID generados en el cliente** (`src/db/ulid.ts`): sin secuencias ni coordinación entre procesos,
  y ordenables por tiempo.
- **Bloqueo de fila antes de escribir.** `updateNote` abre una transacción y hace `SELECT … FOR UPDATE`
  sobre la nota (`src/db/notes.ts:273`), así que dos updates de la misma nota se serializan.
- **Revisión optimista (`base_rev`).** Si el llamador leyó la nota en `rev: 1` y alguien más ya la dejó
  en `rev: 2`, el servidor **rechaza con `ConflictError`** e informa la revisión vigente
  (`src/db/notes.ts:282`) en vez de sobreescribir. La tool devuelve el conflicto al agente, que debe
  releer y reintentar; sin `base_rev` gana el último en escribir (last-writer-wins declarado).
- **Revisiones append-only.** Cada update inserta la versión anterior en `note_revisions` **en la misma
  transacción** (`src/db/notes.ts:290`): nunca queda un estado intermedio ni un historial huérfano.
- **Borrado lógico.** `cortex_delete` marca `deleted_at` y exige `author` + `reason`; no hay `DELETE`
  físico, así que un borrado no rompe referencias ni revisiones.
- **Deduplicación que avisa, no bloquea.** Antes de crear, el servidor responde `similar_exists` con las
  candidatas (similitud ≥ `DUPLICATE_THRESHOLD`, 0.55); crear igual requiere `force: true`. No hay locks
  de «nombre único» ni fusiones automáticas: el humano decide.
- **Los tests no tocan la base compartida.** `test/preload.ts` apunta siempre a un Postgres local
  (`cortex_test` en `127.0.0.1:5433`) y no lee el `DATABASE_URL` del `.env`.

## Configuración de la base

Cortex **necesita PostgreSQL 16 con `pgvector`**: no hay otra persistencia ni caché de notas en disco. La
conexión se define en `DATABASE_URL` y cambia según el contexto:

| Contexto | Dónde se define |
|---|---|
| Servidor (`bun run dev`, producción) | variable de entorno del proceso; en local Prisma la lee del `.env` de la raíz (ignorado por git) |
| `docker compose up` (servicio `server`) | `${DATABASE_URL:-…}` en `docker-compose.yml`: la toma del entorno del shell, del `.env` junto al compose, o si no hay ninguna, del servicio `db` |
| Base local de desarrollo | servicio `db` del compose: imagen `pgvector/pgvector:pg16`, puerto host `5433` |
| Base externa o administrada (Neon, RDS) | la `DATABASE_URL` del proveedor, terminada en `?sslmode=require` (esos Postgres exigen TLS); la base tiene que traer `pgvector` |
| Tests | no se toma del `.env`: `test/preload.ts` usa `127.0.0.1:5433` y `bunfig.toml` fija `[test.env] DATABASE_URL` en `cortex_test` |

En compose la precedencia es explícita: **variable del shell > `.env` > default del compose**. El `.env`
va en la raíz del repo, al lado de `docker-compose.yml` (compose lo busca ahí, no en la carpeta desde
donde corrés el comando). Para ver qué URL va a usar el compose sin levantar nada:

```bash
docker compose config | grep DATABASE_URL
```

La migración inicial habilita `vector`, `unaccent` y `pg_trgm` (`CREATE EXTENSION IF NOT EXISTS`), así
que el único requisito del Postgres destino es **traer esas extensiones instaladas**: imagen
`pgvector/pgvector`, paquete `postgresql-16-pgvector` en Debian/Arch, o la extensión habilitada en el
proveedor administrado (Neon ya la trae). La `DATABASE_URL` nunca se commitea (`.env` está ignorado por
git).

> **`docker compose up` aplica las migraciones sobre la base que diga `DATABASE_URL`.** Antes de
> arrancar, el contenedor corre `bun run db:migrate` (`prisma migrate deploy`): solo aplica migraciones
> **pendientes** y nunca baja de versión, así que repetir `up` es idempotente. Pero si apunta a una base
> **compartida o externa** (Neon), tu `up` la migra para todos. Mientras desarrollás, apuntá a una base
> propia; antes de levantar contra la compartida revisá qué migraciones nuevas lleva tu checkout
> (`git log --oneline -- prisma/migrations`).

El modelo se guarda en el volumen `model-cache` y la base en `pgdata`: recrear el contenedor no pierde
notas ni re-descarga el modelo. Para borrar todo (base incluida): `docker compose down -v`.

## Importar conocimiento existente

```bash
# (a) Desde el repo de conocimiento anterior:
bun run import -- /srv/repos/novara-knowledge

# (b) Desde repos de código que tengan .bitacora/learnings/:
bun run import -- /srv/repos/nucleo-core/backend
bun run import -- /srv/repos/nucleo-core/frontend
```

Es idempotente: volver a correrlo no duplica (cada nota lleva un tag `origen:<repo>:<ruta>`).

## Fallos esperados del contenedor

Si el arranque no puede trabajar, el contenedor **sale con código ≠ 0 y lo dice** en vez de quedarse a
medias:

| Situación | Qué ves en `docker logs cortex` |
|---|---|
| Falta `DATABASE_URL` | `error: DATABASE_URL no está definida.` y el ejemplo del `-e` |
| URL inalcanzable, sin permisos o sin `pgvector` | `error: no se pudieron aplicar las migraciones.` y «Revisá DATABASE_URL: debe apuntar a un PostgreSQL 16 con pgvector accesible» |

Los dos servicios del compose (`db` y `server`) tienen `restart: unless-stopped`: si el host se reinicia,
vuelven a subir solos, siempre que el daemon de Docker arranque con el sistema (en Linux,
`sudo systemctl enable --now docker`; en macOS y Windows, «Start at login» de Docker Desktop).

## Publicar la imagen

La imagen se publica con un workflow de GitHub Actions que se dispara con un tag:

```bash
git tag v0.2.0 && git push --tags
```

El package de GHCR **nace privado** por defecto, incluso en un repo público: tras el primer push del tag
hay que hacerlo público **una sola vez** para que el `docker pull` anónimo funcione:

```bash
gh api -X PATCH /user/packages/container/cortex -f visibility=public
```

Sin ese paso, `docker pull ghcr.io/jastorgalj/cortex:latest` responde 401. El workflow construye solo
`linux/amd64`; publicar `arm64` está pendiente.

## Skills del repo

El repo trae dos skills y un instalador, porque son dos audiencias:

| Skill | Para quién | Qué resuelve |
|---|---|---|
| `cortex-mcp` | el agente que **usa** el MCP | cuándo buscar y qué escribir, deduplicado (`similar_exists`), `base_rev`, borrado con motivo, qué nunca se guarda |
| `cortex-mcp-project` | quien **desarrolla** el servidor | migraciones con `migrate deploy`, tests contra el Postgres local, entrega por rama + PR, receta contra Neon |

Con el repo clonado:

```bash
python scripts/install-skill.py                        # las dos, Hermes y Claude si existen
python scripts/install-skill.py --skills cortex-mcp     # solo la de uso del MCP
python scripts/install-skill.py --target hermes --profiles coder,reviewer
python scripts/install-skill.py --claude-project .      # además como skills de proyecto
```

Windows: `py scripts\install-skill.py` (el `~` es `%USERPROFILE%`). Destinos: `~/.hermes/skills/<categoría>/<skill>`
y `~/.claude/skills/<skill>` (más `<repo>/.claude/skills/…` con `--claude-project`). Va como **copia**, no
como symlink: el escáner de skills de Hermes no sigue enlaces. Si editás una skill, commiteala y volvé a
correr el script; el menú `/` del desktop usa caché, así que después hace falta `/reload-skills`. Para
probar sin tocar las skills reales, pasá `--hermes-home` y `--claude-home`.

## Clientes alternativos (puente stdio)

Si un cliente no soporta HTTP streamable, un puente lo resuelve:

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

## Entrega de cambios

Rama propia + PR contra `main` (el repo no tiene `develop`). Un push directo a `main` no se usa: la
imagen se publica solo por tag, y un tag sale de lo que ya está mergeado.
