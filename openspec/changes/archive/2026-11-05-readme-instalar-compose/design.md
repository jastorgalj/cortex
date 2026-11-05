# Design: Instalación con Docker Compose

## Context

- `docker-compose.yml:23` hardcodea `DATABASE_URL` con la contraseña del servicio `db`. Verificado
  byte a byte: la contraseña de la URL es idéntica a `POSTGRES_PASSWORD` (`docker-compose.yml:7`,
  `cortex_dev`, ya commiteada) y no contiene asteriscos — el `***` que se ve al imprimir es la
  redacción de la herramienta, no contenido del archivo. El defecto no es una credencial rota: es que
  **el valor no se puede pasar por entorno sin editar un archivo versionado**.
- `docker compose` interpola `${...}` con el `.env` situado junto al `docker-compose.yml`, y la
  precedencia es **shell > `.env` > default del compose**. Hoy no hay ninguna interpolación, así que
  el `.env` de la raíz no participa.
- El repo no versiona `.env` (`.gitignore:4`) ni tiene `.env.example`; `.env.example` no está
  ignorado, así que puede commitearse.
- El `Dockerfile` no aplica migraciones: `CMD ["bun","run","src/index.ts"]` (`Dockerfile:38`) y
  `src/` no llama a `migrate` en ningún punto. La imagen copia `prisma/` (`Dockerfile:22`), `prisma`
  está en `dependencies` (`package.json:22`) y ya existe el script `db:migrate` (`package.json:11` →
  `bunx prisma migrate deploy`).
- Solo `server` tiene `restart: unless-stopped` (`docker-compose.yml:42`); `db` no.
- En esta máquina el puerto `5433` ya lo publica el contenedor `cortex-db-test` (base de los tests),
  así que la prueba end-to-end necesita proyecto y puertos aislados.

## Goals / Non-Goals

- **Goals**: instalar de cero con dos comandos; pasar la URL de la base sin editar archivos
  versionados; que los servicios sobrevivan un reinicio del host; que una base vacía quede lista sin
  pasos manuales.
- **Non-Goals**: `.dockerignore` (higiene de build, ver Fuera de alcance del proposal); mover los tests
  a otra base; cambiar la imagen base o el manejo del modelo ONNX.

## Decisions

- **D1 — Migraciones automáticas (decidido por Juan, 2026-11-05).** El servicio `server` aplica
  `bun run db:migrate` antes de arrancar, vía `command:` en `docker-compose.yml`:
  `sh -c "bun run db:migrate && exec bun run src/index.ts"`. El `Dockerfile` **no se toca** (diff
  mínimo: `command` sobreescribe el `CMD` sin tocar la imagen). `migrate deploy` solo aplica pendientes
  y nunca baja de versión, así que es idempotente contra una base vacía y contra una ya migrada.
  `exec` deja a bun como PID 1 para que las señales de Docker lleguen al proceso.
  **Consecuencia aceptada explícitamente**: `docker compose up` migra **la base a la que apunte
  `DATABASE_URL`**, incluida una base externa como Neon; el README tiene que decirlo.
  Alternativas descartadas: paso manual documentado (no cumple «instalación de cero en un comando»);
  migrar en el `Dockerfile` (la base no existe en el build).

- **D2 — Default de `DATABASE_URL`.** `DATABASE_URL: ${DATABASE_URL:-postgresql://cortex:cortex_dev@db:5432/cortex}`.
  Sin `.env` ni variable en el shell, el servidor usa el `db` del compose; la contraseña del default es
  la que ya publica `POSTGRES_PASSWORD` (`docker-compose.yml:7`), que es de desarrollo y no un secreto.

- **D3 — Precedencia verificable.** Se comprueba con `docker compose config` en tres casos: sin `.env`
  → host `db`; con `.env` → gana el `.env`; con `DATABASE_URL` exportada en el shell → gana el shell.
  `docker compose config` muestra el valor resuelto sin levantar nada.

- **D4 — Arranque con el SO (decidido por Juan, 2026-11-05).** `restart: unless-stopped` en **ambos**
  servicios (`db` y `server`) + README con Linux/systemd como camino principal
  (`sudo systemctl enable --now docker`) y **una sola línea** para macOS/Windows («Start at login» de
  Docker Desktop). `restart: unless-stopped` cubre el reinicio del host siempre que el daemon de Docker
  arranque con el sistema: por eso hacen falta las dos piezas.

- **D5 — `.env.example` como vehículo de «cómo pasar la URL».** Archivo nuevo, commiteado, con
  `DATABASE_URL` **comentada** y dos ejemplos (base externa con `sslmode=require`, y el `db` local
  publicado en `127.0.0.1:5433`). `cp .env.example .env` + editar la línea es el paso documentado. No
  se versiona ningún valor real: el `.env` sigue ignorado.

## Risks / Trade-offs

- [Un `.env` con URL de Neon hace que `up` apunte a la base compartida y deje sin uso el `db`] → es el
  comportamiento buscado («pasar la URL»); el `db` sigue siendo el fallback de los tests
  (`test/preload.ts:24`, `bunfig.toml:9`). Aun apuntando a Neon, el servicio `db` arranca por el
  `depends_on`; es costo aceptado, no un defecto.
- [`migrate deploy` en cada `up`] → solo aplica pendientes y nunca baja de versión; el costo es un
  arranque algo más lento.
- [La verificación end-to-end no corre en CI (no hay workflows)] → se prueba localmente en proyecto y
  puertos aislados (tareas 4.x); si el entorno no permite levantar contenedores se declara como
  pendiente y no se da por hecha.
- [El README hoy muestra una contraseña de ejemplo distinta de la real (`README.md:231`)] → se alinea
  en la misma reescritura; es parte de «cómo se pasa la URL», no un extra.

## Open Questions

Ninguna: D1 y D4/D2 quedaron cerradas por Juan (2026-11-05) y están registradas en `propuesta.md` §10.
