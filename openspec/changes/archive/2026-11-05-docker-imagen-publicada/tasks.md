# Tasks

> Borrador alineado con las decisiones D1–D6 (Juan, OK FINAL 2026-11-05). La ejecución real la hace la
> card de `coder` sobre este worktree.

## 1. Publicación de la imagen (D1/D2)

- [x] 1.1 Verificar el build arm64 antes de fijar plataformas: `docker buildx build --platform
  linux/arm64 --load` sobre este worktree. Si compila, el workflow fija
  `platforms: linux/amd64,linux/arm64`; si falla, la primera publicación sale **solo `amd64`** y `arm64`
  queda como tarea de seguimiento con su propio criterio (no se fija una matriz que falla y no publica).
  **Resultado: el build arm64 falló en este host** (`exec format error` en `RUN bun install`, host
  `x86_64` sin QEMU binfmt registrado) → la primera publicación sale **solo `linux/amd64`**. `arm64`
  queda como **tarea de seguimiento**: verificar el build arm64 en un runner/host con emulación QEMU
  (`docker/setup-qemu-action`) o nativo arm64; si compila, agregar `linux/arm64` a `platforms` en
  `.github/workflows/publish.yml` (y volver a correr el workflow de tag).
- [x] 1.2 Crear `.github/workflows/publish.yml`: `on: push: tags: ['v*']`, build con
  `docker/build-push-action` (plataformas según 1.1), push a `ghcr.io/jastorgalj/cortex` con tags `latest`
  y `<version>` (tag git sin la `v`). `permissions: { packages: write }`. Verificar que el YAML es válido
  (p. ej. `actionlint`); el push del tag lo hace Juan.
- [x] 1.3 Fijar el mapeo de versión: la versión de la imagen sale del **tag git** (`v0.2.0` →
  imagen `ghcr.io/jastorgalj/cortex:0.2.0` + `:latest`), y el workflow la **valida contra
  `package.json#version`** con una guarda que falla si difieren (una compuerta, no responsabilidad de
  quien taguea). Documentarlo en el README (grupo 5).
- [x] 1.4 Documentar el paso de **Juan tras el primer push del tag** (no lo ejecuta la card): hacer público
  el package con `gh api -X PATCH /user/packages/container/cortex -f visibility=public` (una sola vez).
  Incluirlo como línea del README junto a las instrucciones de publicación. Sin este paso el `docker pull`
  anónimo responde 401.

## 2. Migraciones en la imagen (D3)

- [x] 2.1 Crear un entrypoint (p. ej. `docker-entrypoint.sh`, copiado y con `exec`) que corra
  `bun run db:migrate && exec bun run src/index.ts`, y apuntar el `ENTRYPOINT`/`CMD` del `Dockerfile` a él.
  Verificar `docker build` + `docker run` contra una base vacía deja `GET /health` en 200 con tablas.
- [x] 2.2 Quitar el `command:` del servicio `server` en `docker-compose.yml` (queda redundante). Verificar
  `docker compose config` y que `compose up` sigue migrando (idempotente).
- [x] 2.3 Fallo rápido: si `db:migrate` falla, imprimir un mensaje que nombre `DATABASE_URL` y el requisito
  (PostgreSQL 16 + pgvector) y salir con código distinto de cero. Verificar contra una URL inválida.

## 3. `.dockerignore` y no-root (D6)

- [x] 3.1 Crear `.dockerignore` (`.env`, `.git`, `node_modules`, `skills/`, `test/`, `*.log`). Verificar
  que el contexto de build no incluye `.env` (el build no lo copia a ninguna capa).
- [x] 3.2 Agregar usuario no-root al runtime y ajustar permisos del cache `/app/.model-cache`. Verificar
  `docker run` no-root y `GET /health` 200.

## 4. Skill sin clonar (D4)

- [x] 4.1 En `scripts/install-skill.py`, cuando `REPO_DIR/skills` no exista, descargar **el árbol completo**
  de cada skill desde `raw.githubusercontent.com/jastorgalj/cortex/main/skills/<skill>/…` a un dir
  temporal y proseguir. Árbol esperado: `cortex-mcp/SKILL.md` y `cortex-mcp-project/SKILL.md` +
  `cortex-mcp-project/scripts/verify-initial-migration.sh`. Verificar que el script quedó instalado (ruta
  y sha) en un entorno sin el repo clonado.

## 5. README

- [x] 5.1 Sección «Descargar la imagen»: `docker pull ghcr.io/jastorgalj/cortex:latest` + el `docker run`
  exacto (`-p 3091:3091`, `-e DATABASE_URL`, `-v cortex-model-cache:/app/.model-cache`,
  `--restart unless-stopped`) + verificación con `/health`.
- [x] 5.2 Sección «Instalar la skill sin clonar»: el one-liner y sus destinos (Hermes + Claude Code).
- [x] 5.3 Corregir el texto que decía «el Dockerfile no cambia» / «command: del compose» a la luz de D3, y
  advertir que `docker run` migra la base a la que apunte `DATABASE_URL`.
- [x] 5.4 Añadir la línea de visibilidad pública del package (el paso manual de Juan del grupo 1.4) junto a
  las instrucciones de publicación.

## 6. Validación de cierre

- [x] 6.1 `bun run typecheck` (0 errores) y `bun test` (66 pass / 0 fail), sin regresión del baseline.
- [x] 6.2 `openspec validate docker-imagen-publicada --type change --strict` sin errores ni warnings.
- [x] 6.3 End-to-end: `docker build` + `docker run` contra una base aislada → `GET /health` 200 con
  migraciones aplicadas (corrido por el `coder`: `/health` 200 `{"status":"ok","notes":0,
  "model_loaded":true}`; segundo arranque `No pending migrations to apply.`; `id -u`=1000); y el
  instalador de skill sin repo deja las skills en `~/.hermes/skills/` y `~/.claude/skills/` (homes
  falsos, `verify-initial-migration.sh` con sha idéntico). Cierre: `typecheck` exit 0, `bun test`
  66 pass / 0 fail / 203 expect, `validate --strict` → valid.
- [x] 6.4 `bun run typecheck` → exit 0 (0 errores) y `bun test` → 66 pass / 0 fail / 203 expect() calls,
  re-corridos por el closer.
- [x] 6.5 `openspec validate docker-imagen-publicada --type change --strict` → `is valid`, sin warnings
  (closer).

## Workflow follow-up

Pasos que **ninguna card** ejecuta — los hace Juan después de mergear el PR:

- Publicar la imagen: crear y pushear el tag `v0.2.0` (tiene que coincidir con `package.json#version`;
  el workflow falla si no). El workflow publica `ghcr.io/jastorgalj/cortex:0.2.0` + `:latest` (solo
  `linux/amd64`).
- Hacer público el package una sola vez tras el primer push:
  `gh api -X PATCH /user/packages/container/cortex -f visibility=public` (sin esto el `docker pull`
  anónimo responde 401).
- Verificar el one-liner del README tal cual (`curl -fsSL …/scripts/install-skill.py | python3 -`) contra
  la rama `main` ya mergeada.
- `arm64`: verificar el build en un runner/host con QEMU binfmt o nativo arm64; si compila, agregar
  `linux/arm64` a `platforms` en `.github/workflows/publish.yml` y volver a correr el workflow del tag.
