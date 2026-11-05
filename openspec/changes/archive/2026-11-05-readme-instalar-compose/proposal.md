# Proposal: Instalación con Docker Compose documentada y reproducible

## Why

Cortex se instala hoy con una sección «Levantar con Docker Compose» (`README.md:294`) que se reduce a un
comando, sin explicar cómo se pasa la URL de la base ni cómo dejar el servicio arrancando con el SO. La
`DATABASE_URL` está **hardcodeada** en `docker-compose.yml:23`: no interpola `${...}`, así que el `.env`
de la raíz no participa y la única forma de apuntar a otra base es editar un archivo versionado. El
contenedor tampoco aplica migraciones (`Dockerfile:38`), así que una base vacía queda sin tablas, y el
servicio `db` no tiene política de reinicio (solo `server`, `docker-compose.yml:42`).

La credencial del default **no** es el problema: se verificó byte a byte que la contraseña de la URL es
idéntica a `POSTGRES_PASSWORD` (`docker-compose.yml:7`) y no lleva asteriscos — el `***` que se ve al
imprimir es la redacción de las herramientas. Lo que falta es el mecanismo para pasar la URL por
entorno y la documentación de la instalación completa.

## What Changes

- `docker-compose.yml`: `DATABASE_URL` del servicio `server` pasa a `${DATABASE_URL:-postgresql://cortex:cortex_dev@db:5432/cortex}`,
  para sobreescribirse con un `.env` (o con el entorno del shell) sin editar el archivo.
- `docker-compose.yml`: `command:` del `server` aplica `bun run db:migrate` antes de arrancar
  (`sh -c "bun run db:migrate && exec bun run src/index.ts"`). El `Dockerfile` **no se modifica**.
  Consecuencia documentada en el README: `docker compose up` migra la base a la que apunte
  `DATABASE_URL`, incluida una base externa.
- `docker-compose.yml`: el servicio `db` gana `restart: unless-stopped`.
- Nuevo `.env.example` con `DATABASE_URL` comentada: el vehículo de «cómo pasarla».
- `README.md`: «Levantar con Docker Compose» reescrita con la instalación completa (prerrequisitos,
  `cp .env.example .env`, `docker compose up --build -d`, verificación con `/health`, cómo se pasa la
  URL y su precedencia, advertencia de migraciones) y una sección de arranque con el SO (Linux/systemd
  como camino principal, una línea para macOS/Windows). Se alinea el ejemplo de URL de
  `README.md:231`, que hoy muestra una contraseña distinta de la real.

## Capabilities

### New Capabilities

Ninguna.

### Modified Capabilities

- `servidor-mcp`: cuatro requisitos añadidos (instalación reproducible, URL por entorno, migraciones
  pendientes al levantar, arranque con el SO). No modifica ninguno de los existentes.

## Impact

- Archivos: `docker-compose.yml`, `.env.example` (nuevo), `README.md`. `Dockerfile` **sin cambios**.
- Sin cambio de API, de modelo de datos ni de dependencias.
- Fuera de alcance: `.dockerignore` (higiene de build, hoy el build manda `node_modules` y `.git` al
  daemon; `Dockerfile:8` `COPY . .` sin `.dockerignore`).
