# Proposal: Imagen Docker publicada + skill instalable sin clonar

## Why

Cortex hoy solo se instala clonando el repo (`git clone` + `docker compose up --build -d`,
`README.md:310-314`). El usuario quiere que el usuario final baje una imagen, setee la URL de la base y
tenga el servidor andando, más instalar la skill sin el repo. Hoy la imagen no está publicada (no hay
`.github/`), la migración vive en el `command:` del compose y no en la imagen (`docker-compose.yml:21`), y
`scripts/install-skill.py` lee `skills/` del repo clonado (`REPO_DIR = Path(__file__).resolve().parent.parent`,
`scripts/install-skill.py:39`).

## What Changes

- Nuevo `.github/workflows/publish.yml`: build+push de la imagen a GHCR (`ghcr.io/jastorgalj/cortex`) en
  tag/release, con tags `:latest` y `:<version>` de `package.json`. El publish lo dispara Juan con un tag;
  ninguna card publica. (D1/D2)
- El package de GHCR nace **privado** por defecto, incluso en repo público: tras el primer push del tag,
  Juan lo hace público una sola vez (`gh api -X PATCH /user/packages/container/cortex -f visibility=public`),
  documentado en el README. Sin eso el `docker pull` anónimo responde 401. (D2)
- `Dockerfile`: entrypoint que aplica `bun run db:migrate` antes de servir, para que un `docker run` sea
  autosuficiente; el `command:` del compose pasa a ser redundante y se quita. (D3)
- `Dockerfile`: usuario no-root y nuevo `.dockerignore` (higiene de build; sin él, el contexto de build
  manda `.env` y `node_modules`). (D6)
- `scripts/install-skill.py`: modo autocontenido que descarga el **árbol completo** de `skills/` (incluido
  `cortex-mcp-project/scripts/verify-initial-migration.sh`, no solo los `SKILL.md`) de
  `raw.githubusercontent.com` cuando no está en un repo, para instalar sin clonar. (D4)
- `README.md`: sección «Descargar la imagen» con el `docker run` exacto, la línea de visibilidad pública del
  package y sección de instalación de la skill sin clonar.

## Capabilities

### New Capabilities

Ninguna.

### Modified Capabilities

- `servidor-mcp`: cuatro requisitos añadidos (imagen publicada, `docker run` con base externa, skill sin
  clonar, falla rápida ante base inválida) y uno modificado («Las migraciones pendientes se aplican al
  levantar el servicio», para abarcar `docker run`, no solo Compose). El resto de los requisitos vigentes
  no cambian.

## Impact

- Archivos: `.github/workflows/publish.yml` (nuevo), `Dockerfile`, `docker-compose.yml` (quita `command:`),
  `.dockerignore` (nuevo), `scripts/install-skill.py`, `README.md`.
- Sin cambio de API, de modelo de datos ni de dependencias.
- El publish de la imagen es un evento de release que dispara Juan; no es parte del PR. La visibilidad
  pública del package es un paso manual de Juan tras el primer tag, documentado en el README.
