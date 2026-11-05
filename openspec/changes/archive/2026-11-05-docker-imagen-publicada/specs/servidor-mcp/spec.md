# Spec Delta

## ADDED Requirements

### Requirement: Imagen Docker publicada y descargable sin checkout

El proyecto SHALL publicar una imagen de contenedor en un registry público descargable sin
autenticación, con los tags `:latest` y `:<version>` derivado del tag git y validado contra la versión
de `package.json` (el workflow falla si difieren); la
publicación SHALL dispararse solo desde un tag o release, nunca desde un push a la rama por defecto ni
desde una card. Razón: el usuario final debe bajar Cortex sin clonar el repo.

#### Scenario: Descarga anónima de la imagen

- **WHEN** un usuario ejecuta `docker pull ghcr.io/jastorgalj/cortex:latest` sin autenticarse
- **THEN** la imagen se descarga y un `docker run` con ella arranca el servidor

#### Scenario: El package es público

- **WHEN** el package de GHCR se ha marcado público tras el primer push
- **THEN** `docker pull ghcr.io/jastorgalj/cortex:latest` sin autenticarse responde con la imagen, no 401

#### Scenario: La publicación solo la dispara un tag

- **WHEN** alguien hace push a `main` sin crear un tag ni un release
- **THEN** no se publica ninguna imagen en el registry

### Requirement: Instalación con `docker run` y base externa

El README SHALL documentar un comando `docker run` único —puerto `3091`, `DATABASE_URL` por `-e`, cache
del modelo en un volumen y `--restart unless-stopped`— que deja `GET /health` en 200 contra la base
apuntada, con las migraciones aplicadas, sin clonar el repo ni editar archivos versionados. Razón: el
entregable pedido es un solo comando donde el usuario solo setea la URL de la base.

#### Scenario: Arranque con la URL de la base

- **WHEN** se ejecuta el comando `docker run` documentado con `-e DATABASE_URL` apuntando a una base
  externa vacía
- **THEN** el contenedor aplica las migraciones y `GET http://localhost:3091/health` responde 200

#### Scenario: El cache del modelo sobrevive

- **WHEN** se recrea el contenedor con el mismo volumen de cache y la misma `DATABASE_URL`
- **THEN** no se re-descarga el modelo y `GET /health` responde 200 con `model_loaded: true`

### Requirement: Instalación de la skill sin clonar el repo

El proyecto SHALL ofrecer un instalador de las skills (`cortex-mcp` y `cortex-mcp-project`) ejecutable
sin clonar el repo —descargable por `curl` a una URL pública y autocontenido—, que instale en Hermes
(`~/.hermes/skills/`) y en Claude Code (`~/.claude/skills/`). Razón: la skill es lo que el agente
necesita para usar el MCP, y hoy exige tener el repo.

#### Scenario: Instalar sin checkout

- **WHEN** un usuario descarga y ejecuta el instalador documentado sin tener el repo clonado
- **THEN** las dos skills quedan instaladas en sus rutas de Hermes y Claude Code

#### Scenario: La skill de proyecto llega completa

- **WHEN** un usuario instala la skill sin clonar el repo
- **THEN** `cortex-mcp-project` queda instalada con su `scripts/verify-initial-migration.sh`, no solo el
  `SKILL.md`

#### Scenario: Un destino ausente no frena al resto

- **WHEN** una raíz destino no existe (p. ej. `~/.claude`)
- **THEN** el instalador salta ese destino con un mensaje y sigue con los demás

### Requirement: Falla rápido si la base no sirve

Al arrancar, si `DATABASE_URL` no apunta a un PostgreSQL 16 con `pgvector` accesible (conexión imposible,
rol sin permisos o extensión faltante), el contenedor SHALL terminar con un mensaje accionable que nombre
`DATABASE_URL` y el requisito de la base, sin dejar el proceso a medias. Razón: un arranque que falla en
silencio deja al usuario reintentando a ciegas.

#### Scenario: Base inaccesible

- **WHEN** se arranca el contenedor con un `DATABASE_URL` que no es accesible
- **THEN** el proceso termina con un mensaje que nombra `DATABASE_URL` y pide revisar que sea un
  PostgreSQL 16 con pgvector

## MODIFIED Requirements

### Requirement: Las migraciones pendientes se aplican al levantar el servicio

Al arrancar el contenedor del servidor —con Docker Compose o con `docker run`—, la imagen SHALL aplicar
las migraciones pendientes sobre la base indicada por `DATABASE_URL` antes de empezar a servir. El README
SHALL advertir que esa migración corre contra la base apuntada, incluida una externa. Razón: una base vacía
debe quedar utilizable sin pasos manuales.

#### Scenario: Base vacía

- **WHEN** se arranca el contenedor contra una base sin tablas (con Compose o con `docker run`)
- **THEN** el contenedor aplica las migraciones pendientes y `GET /health` responde 200 con las tablas del
  modelo creadas, sin ningún paso previo manual

#### Scenario: Base vacía con docker run

- **WHEN** se ejecuta el comando `docker run` documentado contra una base externa vacía
- **THEN** el contenedor aplica las migraciones pendientes sobre esa base y `GET /health` responde 200

#### Scenario: El README advierte que migra la base apuntada

- **WHEN** el lector configura `DATABASE_URL` hacia una base externa
- **THEN** el README le advierte que el arranque aplica las migraciones pendientes sobre esa base
