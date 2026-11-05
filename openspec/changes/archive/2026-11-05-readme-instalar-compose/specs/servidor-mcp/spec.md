# Spec Delta

## ADDED Requirements

### Requirement: Instalación con Docker Compose reproducible

El README SHALL documentar la instalación completa con Docker Compose desde un checkout limpio
—comandos exactos y verificación—, y esos pasos SHALL dejar `GET /health` en 200 contra una base con
las migraciones aplicadas. Razón: instalar de cero no debe exigir leer el código ni editar archivos
versionados.

#### Scenario: Instalación desde un checkout limpio

- **WHEN** en un checkout limpio se copia la plantilla de configuración a `.env` y se ejecuta
  `docker compose up --build -d`
- **THEN** `GET http://localhost:3091/health` responde 200 y la base queda con las tablas del modelo
  creadas

#### Scenario: El README indica cómo verificar la instalación

- **WHEN** un lector sigue la sección de instalación del README
- **THEN** encuentra el comando de verificación (`GET /health`) y el resultado esperado, sin tener que
  deducirlo del código

### Requirement: La URL de la base se pasa por entorno sin editar el compose

`DATABASE_URL` SHALL poder configurarse por entorno —`.env` junto al `docker-compose.yml` o variable
del shell— sin editar el archivo versionado, y SHALL tener un valor por defecto que apunte al servicio
`db` del compose. La variable del shell SHALL tener precedencia sobre el `.env`. Razón: la base es
externa al proyecto (Neon hoy) y su URL no puede quedar fija en el compose.

#### Scenario: URL apuntada a una base externa

- **WHEN** el `.env` define `DATABASE_URL` apuntando a una base externa (p. ej. Neon)
- **THEN** al levantar los servicios el servidor conecta a esa base sin que se edite
  `docker-compose.yml`

#### Scenario: Sin `.env` se usa el servicio db del compose

- **WHEN** no existe `.env` ni `DATABASE_URL` en el entorno del shell
- **THEN** el servidor conecta al servicio `db` del compose

#### Scenario: El entorno del shell gana sobre el `.env`

- **WHEN** el `.env` y el entorno del shell definen valores distintos de `DATABASE_URL`
- **THEN** el servidor usa la URL del shell

### Requirement: Las migraciones pendientes se aplican al levantar el servicio

Al levantar el servicio `server` con Docker Compose, el contenedor SHALL aplicar las migraciones
pendientes sobre la base indicada por `DATABASE_URL` antes de empezar a servir. El README SHALL
advertir que esa migración corre contra la base apuntada, incluida una externa. Razón: una base vacía
debe quedar utilizable sin pasos manuales.

#### Scenario: Base vacía

- **WHEN** se levantan los servicios contra una base sin tablas
- **THEN** el servidor aplica las migraciones pendientes y `GET /health` responde 200 con las tablas
  del modelo creadas, sin ningún paso previo manual

#### Scenario: El README advierte que migra la base apuntada

- **WHEN** el lector configura `DATABASE_URL` hacia una base externa
- **THEN** el README le advierte que el arranque aplica las migraciones pendientes sobre esa base

### Requirement: Los servicios arrancan con el sistema operativo

Los servicios `db` y `server` SHALL reiniciarse automáticamente tras un reinicio del host, y el README
SHALL documentar cómo dejar el daemon de Docker arrancando con el sistema —Linux/systemd como camino
principal, y una línea para macOS/Windows—. Razón: un reinicio del host no debe dejar el servidor
caído hasta que alguien lo levante a mano.

#### Scenario: Reinicio del host

- **WHEN** el host se reinicia con los servicios ya levantados y el daemon de Docker habilitado
- **THEN** ambos servicios vuelven a estar arriba sin intervención manual

#### Scenario: Instrucciones por plataforma

- **WHEN** el lector busca cómo dejar Docker arrancando con el sistema
- **THEN** el README da el procedimiento de Linux (systemd) y menciona en una línea macOS y Windows
