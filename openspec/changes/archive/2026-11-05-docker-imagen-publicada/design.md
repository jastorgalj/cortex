# Design: Imagen Docker publicada + skill sin clonar

## Context

- Repo **público** (verificado `gh api repos/jastorgalj/cortex` → `public`, `private=false`), única rama
  `main`. `raw.githubusercontent.com` sirve las skills anónimamente (verificado HTTP 200 sobre
  `skills/cortex-mcp/SKILL.md`).
- No hay `.github/` (0 workflows). `oven/bun:latest` es multi-arch (amd64+arm64).
- `Dockerfile` corre como root, no copia `skills/`, no aplica migraciones; la migración la hace el
  `command:` del compose (`docker-compose.yml:21`).
- `scripts/install-skill.py:39` fija `REPO_DIR = Path(__file__).resolve().parent.parent`: el instalador
  asume que corre dentro de un checkout. `skills/` son dos dirs: `cortex-mcp` (`SKILL.md`) y
  `cortex-mcp-project` (`SKILL.md` + `scripts/verify-initial-migration.sh`).
- El modelo ONNX (`Xenova/all-mpnet-base-v2`, `src/db/embeddings.ts:12`) se descarga en runtime
  (`env.cacheDir`, `embeddings.ts:22`); el README ya decide que **no se redistribuye** (`README.md:453-455`).
- `migrate deploy` es idempotente y no baja de versión; `prisma` está en `dependencies` (`package.json:22`)
  y `prisma/` se copia a la imagen (`Dockerfile:22`), así que corre en runtime.
- `warmup()` bloquea el arranque hasta que el modelo está cargado (`src/index.ts:98-99`), antes de
  `app.listen`; por eso `/health` 200 ya reporta `model_loaded: true`, y el healthcheck tiene
  `start_period: 120s` (`Dockerfile:35`).

## Goals / Non-Goals

- **Goals**: imagen pública descargable; un `docker run` autosuficiente con `-e DATABASE_URL`; instalar la
  skill sin clonar; fallar rápido con mensaje accionable si la base no sirve.
- **Non-Goals**: autenticación; cambiar el modelo ONNX; hornear el modelo en la imagen (descartado por
  `README.md:453-455`); migrar a un registry distinto de GHCR.

## Decisions

- **D1 — Registry GHCR** (decidido por Juan, 2026-11-05). `ghcr.io/jastorgalj/cortex`: repo ya en GitHub y
  público → pull anónimo sin login. Docker Hub exige cuenta y PAT aparte y un paso de login que GHCR no
  pide.

- **D2 — Publicación por workflow en tag + visibilidad pública del package** (decidido por Juan,
  2026-11-05). `.github/workflows/publish.yml` con `on: push: tags: ['v*']` y
  `permissions: { packages: write }`. El tag `v<version>` produce los tags de imagen `latest` y
  `<version>`: la versión sale del **tag git** (`v0.2.0` → `:0.2.0`) y el workflow la **valida contra
  `package.json#version`** con una guarda que falla si difieren (una compuerta, no responsabilidad de
  quien taguea). El push del tag lo hace Juan (regla: ninguna card publica).
  **El package de GHCR nace privado por defecto, incluso en repo público**: tras el primer push del tag,
  Juan lo hace público **una sola vez** con `gh api -X PATCH /user/packages/container/cortex -f
  visibility=public` (o la UI del package). Sin ese paso, `docker pull` anónimo responde 401 y el
  requirement «descargable sin autenticación» no se cumple. El build+push manual se descarta: exige
  `docker login` con token de paquete en la máquina de Juan en cada versión.

- **D3 — Migraciones en la imagen** (decidido por Juan, 2026-11-05). Un entrypoint (`docker-entrypoint.sh`
  o un script Bun) que corra `bun run db:migrate && exec bun run src/index.ts`, y se quita el `command:`
  del servicio `server` en el compose. **Revierte D1 del change archivado `readme-instalar-compose`** («el
  Dockerfile no se toca»): aquello era correcto cuando la migración solo ocurría vía compose; ahora el
  `docker run` la necesita en la imagen. `migrate deploy` idempotente → arrancar con compose sigue
  migrando igual, sin doble migración.

- **D4 — Skill sin clonar por curl, trayendo el árbol completo** (decidido por Juan, 2026-11-05).
  `install-skill.py` gana un fallback: si `REPO_DIR/skills` no existe, descarga **el árbol completo** de
  cada skill desde `raw.githubusercontent.com/jastorgalj/cortex/main/skills/<skill>/…` a un dir temporal
  y procede. El árbol completo incluye, para `cortex-mcp-project`, su `scripts/verify-initial-migration.sh`
  (no solo el `SKILL.md`); el instalador verifica que el script quedó instalado (ruta + sha). One-liner:
  `curl -fsSL <raw>/install-skill.py -o /tmp/install-cortex-skill.py && python /tmp/install-cortex-skill.py`.
  El subcomando de imagen se descarta: la imagen no trae Python ni `skills/`, y montar `~/.hermes` y
  `~/.claude` es frágil entre SO.

- **D5 — Modelo ONNX en runtime** (decidido por Juan, 2026-11-05). Se mantiene la descarga al primer
  arranque + volumen `model-cache`. Hornearlo agrega ~420 MB a la imagen y contradice «no se redistribuye»
  (`README.md:453-455`). Se alinea el `start_period` del healthcheck para tolerar la primera descarga.

- **D6 — No-root + `.dockerignore` + multi-arch condicionado** (decidido por Juan, 2026-11-05). `USER`
  no-root (el usuario `bun` ya existe en `oven/bun`), `.dockerignore` (excluye `.env`, `.git`,
  `node_modules`, `skills/`, `test/`). Multi-arch **condicionado**: antes de fijar
  `platforms: linux/amd64,linux/arm64` en el workflow, se verifica que el build arm64 compila
  (`docker buildx build --platform linux/arm64 --load`). Si no compila (p. ej. por
  `@huggingface/onnxruntime`/`@huggingface/transformers`), la primera publicación sale **solo `amd64`** y
  `arm64` queda como tarea de seguimiento con su propio criterio — nunca un workflow cuya matriz falla y
  no publica nada.

  **Resultado de la verificación (coder, 2026-11-05):** `docker buildx build --platform linux/arm64
  --load` falló con `exec format error` en el `RUN bun install` — el host de build es `x86_64` y no
  tiene QEMU binfmt registrado, así que no se pudo compilar ni ejecutar arm64. La primera publicación
  sale **solo `linux/amd64`**. `arm64` queda como **tarea de seguimiento**: verificar el build arm64 en
  un runner/host con emulación QEMU (`docker/setup-qemu-action`) o nativo arm64; si compila, agregar
  `linux/arm64` a `platforms` en `.github/workflows/publish.yml` y volver a publicar el tag.

## Risks / Trade-offs

- Mover la migración a la imagen cambia el mecanismo que documentó `readme-instalar-compose`; el
  comportamiento observable es el mismo (o más amplio). El texto del README que dice «el Dockerfile no
  cambia» / «el command: del servicio» hay que corregirlo en la misma reescritura.
- `.dockerignore` no existe hoy: el build manda `.env` (con `DATABASE_URL` real) y `node_modules` al
  contexto. Para una imagen **publicada** es obligatorio; revierte el «fuera de alcance» del change
  archivado.
- El primer arranque de la imagen descarga ~420 MB del modelo: si el `start_period` del healthcheck no
  alcanza, Docker reinicia el contenedor (el volumen mitiga la re-descarga). Ver D5.
- La visibilidad pública del package es un paso manual de Juan tras el primer tag; si se olvida, el pull
  anónimo falla con 401 (no es un defecto del build, es la política de GHCR). Ver D2.
