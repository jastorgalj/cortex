---
name: cortex-mcp-project
description: Use when working on the Cortex MCP server repo.
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [cortex, mcp, prisma, pgvector, bun, elysia]
    related_skills: [neon-database-ops, prisma-rebaseline]
---

# Cortex (servidor MCP de memoria compartida)

## When to Use

Cualquier tarea en `~/develop/varios/cortex` (repo `jastorgalj/cortex`): cambios de código,
migraciones Prisma, tests, documentación OpenSpec o configuración de la base (local o Neon).

Proyecto **personal** del usuario (no de TGT/Deta). Repo local `~/develop/varios/cortex`,
remoto `https://github.com/jastorgalj/cortex` (público, cuenta personal, NO `tgtjam`).
Stack: Bun + Elysia + Prisma + Postgres 16 con `pgvector` (embeddings ONNX locales).

## Entrega: rama + PR, nunca push a `main`

El repo solo tiene `main` (no hay `develop`), pero **`main` no recibe pushes directos**. Un cambio se
entrega en su worktree, con rama propia y PR a `main`:

```bash
cd ~/develop/varios/cortex
git worktree add .worktrees/<slug> -b feat/<slug>     # .worktrees/ va en .git/info/exclude
cp ../../.env .env && (cd .worktrees/<slug> && bun i)
# …trabajo, gates…
git push -u origin feat/<slug>
GH_TOKEN="$(gh auth token --user jastorgalj)" gh pr create \
  --repo jastorgalj/cortex --base main --head feat/<slug> --title "…" --body "…"
```

`gh` queda autenticado como **`tgtjam`** (cuenta de trabajo): sin el `GH_TOKEN` de `jastorgalj` el PR
responde 404 y `git ls-remote`/`push` falla con «Repository not found». El repo tiene un
`credential.https://github.com.helper` local que devuelve el token de `jastorgalj` para el push; el
`GH_TOKEN` hace falta para las llamadas de la API (`gh pr create`, `gh api`). Verificar antes de
usarlo: `GH_TOKEN="$(gh auth token --user jastorgalj)" gh api user -q .login` → `jastorgalj`.

Los tests de un worktree nuevo necesitan `bun i` (no comparte `node_modules`) y el Postgres local
`cortex_test` en `127.0.0.1:5433`; no leen el `.env`.

**Card de kanban con PR: `completion_contract="local-only"`.** El repo es **público** y tiene rulesets
(PR obligatorio), pero **no tiene required status checks**: el workflow `.github/workflows/publish.yml`
publica en tag y no valida PRs. Con `OWNER/REPO` el gate espera checks que no existen y bloquea la card
con el trabajo ya hecho. El PR se abre igual; lo que cambia es la compuerta de cierre.

## Reglas que no se pueden romper

1. **Base propia.** Nunca reutilizar la BD ni el proyecto Neon del contexto anterior
   (Deta/empresa). El `.env` del usuario tiene `DATABASE_URL` a **su** Neon; no lo edites salvo
   para lo estrictamente pedido.
2. **Nombres anonimizados.** El repo no debe contener nombres reales de clientes/proyectos.
   Los nombres ficticios vigentes hay que preservarlos: Novara (empresa), `cartera`, `huella`,
   `api-scoring`, `nucleo-core`, `bitacora` (`.bitacora/learnings`), CAR-xxx (tickets).
   Rutas de ejemplo: `/srv/repos/...`. Si agregas docs, sigue ese esquema.
3. **`migrate deploy`, nunca `migrate dev` para crear migraciones.** El datamodel no puede expresar
   el índice HNSW del embedding ni el índice parcial de `deleted_at`; `migrate dev` con nombre
   genera una migración que **borra** índices (incluido `notes_fts_gin`, el GIN de la búsqueda).
   Los índices btree y el GIN sí están declarados en `prisma/schema.prisma` (`@@index`, y
   `type: Gin` para `fts`) justamente para que el diff quede vacío.
   Para una migración nueva: SQL a mano en `prisma/migrations/<ts>_<nombre>/migration.sql` +
   `bunx prisma migrate deploy`.
4. **Si `migrate dev` pide un nombre, es drift: Ctrl+C.** No le pongas nombre ni respondas el
   prompt. Antes de cancelar, confirmá qué escribiría con
   `bunx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script`:
   ahí se ven los `DROP INDEX` que generaría. La causa es siempre un objeto que existe en el SQL y
   no en el datamodel — declaralo en `schema.prisma` (o dejalo documentado como solo-SQL si Prisma
   no lo soporta) y el prompt desaparece.
5. **Editar un `migration.sql` ya aplicado cambia su checksum.** `_prisma_migrations` guarda el
   hash del archivo: si lo tocás y después corrés `deploy` contra esa misma base, falla con
   *migration modified after it was applied*. Solo es seguro cuando la base se resetea en el mismo
   paso; si no, agregá una migración nueva.
6. **Los tests no leen el `.env`.** `test/preload.ts` apunta siempre al Postgres local del compose
   (`127.0.0.1:5433`) y crea/migra `cortex_test`; override con `TEST_DATABASE_URL` en el shell.
   No reintroduzcas la derivación desde `.env`: si el `.env` apunta a Neon, los tests escribirían
   en Neon.

## Entorno local

- DBs: `cortex` (dev) y `cortex_test` (tests), usuario `cortex` / `cortex_dev`, puerto 5433.
  `docker compose up -d db` pide `pgvector/pgvector:pg16`; si no está la imagen, sirve `pg15`
  (crear contenedor a mano con `POSTGRES_DB=cortex`, `POSTGRES_USER=cortex`).
- Extensión: la migración inicial hace `CREATE EXTENSION IF NOT EXISTS` de `vector`, `unaccent`,
  `pg_trgm`.
- Cache del modelo: `~/.model-cache/knowledge-mcp` (no renombrar: son ~420 MB que se re-descargan).
  `bun run src/index.ts` hace warmup del ONNX y escucha en 3091. Si `MODEL_CACHE_DIR` apunta a una
  ruta de Windows, en Linux se materializa como carpeta relativa (`C:/...`) **dentro del repo**:
  mirá `git status` después de la primera corrida antes de commitear y mové el cache a una ruta POSIX.
- `bun` no está en el PATH del shell no interactivo: `export PATH="$HOME/.bun/bin:$PATH"`.

## Git / push con dos cuentas

`gh` tiene activa la cuenta de trabajo (`tgtjam`). El helper global por URL
(`credential.https://github.com.helper` → `gh auth git-credential`) gana y devuelve el token de
`tgtjam`, así que el push al repo personal falla con "Repository not found". En este repo hay un
override local que funciona (sin guardar el token en disco):

```bash
cd ~/develop/varios/cortex
git config --local credential.https://github.com.helper ''
git config --local --add credential.https://github.com.helper \
  '!f() { echo username=jastorgalj; echo "password=$(gh auth token --user jastorgalj)"; }; f'
```

Commit identity local: `jastorgalj <jastorgalj@gmail.com>`. El historial se reescribió dos veces
(`--amend` + `--force-with-lease`) para sacar la BD/nombres viejos: el repo es de una sola
entrega, no hay colaboradores.

## Tests: los fixtures están acoplados por similitud

`createNote` consulta duplicados semánticos (`DUPLICATE_THRESHOLD` 0.55) antes de insertar, así que
**cambiar el texto de un fixture puede volverlo "duplicado" de otro** y el test falla con
`if (r.status !== 'created') throw new Error('No se creó')` — parece un bug de lógica y es el
umbral de deduplicación. Reglas:

- Si `createNote` devuelve `similar_exists`, usá `force: true` (convención ya presente en el
  archivo) o cambiá el fixture de tema, no el umbral del producto.
- Un cambio de vocabulario en los fixtures (anonimizar, renombrar dominios) puede mover la
  similitud arriba o abajo: corré **el archivo completo**, no `bun test -t '<test>'`. Un `-t` pasa
  porque no crea los fixtures anteriores y esconde exactamente esta clase de fallo.
- Un test que falla solo en la corrida completa y no aislado (o al revés) es casi siempre
  contaminación entre fixtures del mismo archivo, no concurrencia.

## Verificación estándar

```bash
export PATH="$HOME/.bun/bin:$PATH" && cd ~/develop/varios/cortex
bun run typecheck && bun test          # 66 tests (baseline ago-2026)
# drift contra la base real:
bunx prisma migrate diff --from-url "$(grep '^DATABASE_URL=' .env | cut -d= -f2-)" \
  --to-schema-datamodel prisma/schema.prisma --script            # "empty migration"
# drift del historial de migraciones (shadow) contra el datamodel:
bunx prisma migrate diff --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "$LOCAL_ADMIN_URL" --script             # "empty migration"
```

Baseline completo desde cero (extensiones, trigger FTS, índices): `bash scripts/verify-initial-migration.sh`.
No borres `prisma/migrations/` para "empezar limpio": hay una sola migración y regenerarla con
Prisma pierde `vector`, el HNSW, el índice parcial y el trigger FTS.

Smoke contra la base real: `GET /health` (`model_loaded: true`), `GET /` (200), MCP
`initialize` + `tools/list` (7 tools `cortex_*`). Las tools usan `q`, no `query`.

## Distribución: imagen publicada y skill sin clonar

- **Publicación**: `.github/workflows/publish.yml` corre en tag `v*` con `GITHUB_TOKEN`
  (`permissions: packages: write`) y publica `ghcr.io/jastorgalj/cortex` con `:latest` y `:<version>`.
  **La dispara el usuario** (`git tag vX && git push --tags`): ninguna card publica, tagea ni pushea imagen.
- **Guarda de versión**: el workflow compara `${REF_NAME#v}` con `package.json#version` y falla si
  difieren. Para publicar hay que taguear la versión que dice `package.json`, no al revés.
- **Solo `linux/amd64`**: `docker buildx build --platform linux/arm64` no compila en este host (falta
  QEMU binfmt, «exec format error»), así que arm64 sigue pendiente. En Mac Apple Silicon la imagen corre
  emulada.
- **El package de GHCR nace privado**, incluso en repo público: tras el primer push hay que hacerlo
  público una vez (`gh api -X PATCH /user/packages/container/cortex -f visibility=public`). El token de
  `gh auth token` no tiene `read:packages`, así que `gh api users/<u>/packages` responde 403 y **no sirve**
  para verificar si ya está publicado.
- **La migración vive en el entrypoint** (`docker-entrypoint.sh`), no en el `command:` del compose: un
  `docker run -e DATABASE_URL=…` es autosuficiente y falla rápido si la base no sirve.
- **Validar el workflow con `bun`**, no con `python3`: el Python del host no tiene el módulo `yaml` ni pip.
  `bun -e 'console.log(require("yaml").parse(require("fs").readFileSync(".github/workflows/publish.yml","utf8")))'`
- **El `.env` del repo apunta a Neon**: un `docker compose up` desde un worktree migra esa base. Para
  probar compose, usá proyecto aislado (`-p <nombre>`) y un override con `DATABASE_URL` al `db` propio.
- **El merge de compose concatena listas** (`ports`): un override que reemplaza puertos necesita la
  etiqueta `!override`; si no, quedan `5433` y `5434` juntos y choca con `cortex-db-test`.
- Las cards no pueden `docker restart <contenedor>` (BLOCKED): se recrea con `docker rm -f` + `docker run`.

## Esta skill vive en el repo

El original está en `skills/cortex-mcp-project/` del repo `jastorgalj/cortex`. Lo que carga el agente es
una **copia** (el escáner de skills no sigue symlinks), instalada con `scripts/install-skill.py` en:

- Hermes: `~/.hermes/skills/software-development/cortex-mcp-project`
- Claude Code: `~/.claude/skills/cortex-mcp-project`

Si cambiás algo acá: editá, commit en la rama, PR, y después corré el instalador para que el agente lo
lea. En Windows el `~` es `%USERPROFILE%` y el intérprete puede ser `py`.
