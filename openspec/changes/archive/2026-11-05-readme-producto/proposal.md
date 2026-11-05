# Proposal: README de producto (Docker-only) con CONTRIBUTING separado

## Why

El README actual (`README.md`, 530 líneas) mezcla el pitch de producto con el manual de desarrollo
(clone, `bun i`, `prisma migrate deploy`, tests, OpenSpec, importación, decisiones de concurrencia
interna y publicación de la imagen). Un visitante que quiere saber «para qué sirve y cómo lo levanto»
cruza 500 líneas para llegar a los dos comandos que importan, y el detalle de desarrollo entierra la
primera impresión y no se encuentra cuando se necesita. El usuario pidió explícitamente un README que
**venda**, que deje **solo** el uso con Docker, lo más simple posible, con la comparativa «sin Cortex vs
con Cortex» y SVGs bonitos, y mover el detalle de clonar/desarrollar a otro archivo.

## What Changes

- `README.md` → reescrito de cero, en español y tono producto: qué es y para qué sirve (dolor sin
  Cortex vs con Cortex), cómo funciona, qué guarda, las siete tools, cómo empezar **solo con Docker**
  (`docker pull` + `docker run` + `curl /health` como camino principal, y un bloque breve de `docker
  compose` como alternativa), cómo conectar un agente (Hermes y Claude Code, incluida la instalación de
  skills sin clonar), la API de lectura y la licencia. La sección Docker lleva además la nota de
  seguridad (sin auth, red interna/VPN), el aviso de primer arranque (descarga ~420 MB del modelo ONNX)
  y la línea de arquitectura soportada (solo `linux/amd64`). Cierra con «Cooperar con el desarrollo»,
  que enlaza a `CONTRIBUTING.md`.
- `CONTRIBUTING.md` (nuevo, una sola fuente) → recibe TODO el detalle de desarrollo que sale del
  README: clone, `bun i`, `prisma migrate deploy`, `bun run dev`, tests (`bun test`, `bun run
  typecheck`), OpenSpec, importación (`bun run import`), configuración de la base (tabla de
  contextos), decisiones de concurrencia interna, arquitectura/stack en detalle, fallos esperados del
  contenedor y publicación de la imagen (workflow + `gh api` para hacer público el package).
- `docs/assets/sin-vs-con-cortex.svg` (nuevo) → comparativa sin/con Cortex.
- `docs/assets/flujo-agente-cortex-postgres.svg` (nuevo) → flujo de uso agente↔Cortex↔Postgres.

Sin cambio de código, migración ni dependencia: `docker-compose.yml`, `Dockerfile`,
`docker-entrypoint.sh`, `.env.example`, `scripts/` y `src/` quedan intactos.

## Capabilities

### New Capabilities

Ninguna.

### Modified Capabilities

Ninguna. Cambio de solo documentación: no cambia ningún comportamiento observable del sistema (sin
endpoint nuevo, sin cambio de modelo de datos, sin dependencia nueva). Todo lo que el README describe
ya está especificado en `openspec/specs/servidor-mcp/`, `busqueda/` y `notas/`; este change no altera
ningún requirement. Por eso `skip_specs: true`: no hay delta que escribir ni specs que sincronizar.

## Impact

- Archivos: `README.md` (reescrito), `CONTRIBUTING.md` (nuevo), `docs/assets/*.svg` (2 nuevos).
  Sin cambio de código, de API, de modelo de datos ni de dependencias.
- Riesgo: romper enlaces/anclas al mover secciones a `CONTRIBUTING.md`. Se verifica en la tarea 4. Un
  README que documenta un comando que no corre es peor que no documentarlo: cada comando que queda se
  ejecutó tal cual en esta máquina (verificado de punta a punta en la exploración: `docker pull` +
  `docker run -e DATABASE_URL` + `curl /health` → `{"status":"ok","notes":0,"model_loaded":true}`).
- Fuera de alcance: captura de pantalla de la vista web `/` (el usuario prefiere SVG; la vista es una
  tabla de notas sin valor de imagen). Imagen multi-arch `arm64` (pendiente previo, no de este change).
