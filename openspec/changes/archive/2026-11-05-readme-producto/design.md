# Design: README de producto (Docker-only)

## Decisions

### D1 — Estructura del README nuevo (español, tono producto)

Orden de arriba a abajo, cada sección corta:

1. `# Cortex` + tagline en una línea («la memoria compartida del equipo y de sus agentes»).
2. **¿Qué es?** — 2-3 líneas: qué es y para qué sirve.
3. **Sin Cortex vs con Cortex** — el dolor en palabras + el SVG `sin-vs-con-cortex.svg`.
4. **Cómo funciona** — 2-3 líneas + el SVG `flujo-agente-cortex-postgres.svg`.
5. **Qué guarda** — tabla resumida de los campos de una nota (title/body, app, kind, tags, author,
   issue) y las tres reglas clave (deduplicación con `similar_exists`, historial de revisiones,
   borrado lógico).
6. **Qué puede hacer tu agente** — tabla de las siete tools MCP (nombre → para qué, una línea cada una).
7. **Empezar en dos minutos (Docker)** — camino principal `docker run`: `docker pull` +
   `docker run -e DATABASE_URL` + `curl /health`, con el resultado esperado, y la línea de que una base
   administrada (Neon, RDS) necesita `?sslmode=require` en la URL. **Sin comandos de clonado**: el
   compose con base incluida (que sí necesita `git clone`) vive en `CONTRIBUTING.md`, y el README solo
   lo enlaza con una línea de puntero, sin bloque de código. Incluye dentro de esta sección:
   `> Nota de seguridad`
   (sin auth, red interna/VPN, proxy con auth delante si se expone), el aviso de primer arranque
   (descarga ~420 MB del modelo ONNX, puede tardar minutos, `model_loaded: true` es la señal) y la línea
   de arquitectura soportada (solo `linux/amd64`; en Apple Silicon corre emulada).
8. **Conectar tu agente** — Hermes (`hermes mcp add`), Claude Code (`claude mcp add` + `.mcp.json`) y
   la instalación de las skills sin clonar (`curl .../scripts/install-skill.py`).
9. **API de lectura** — `GET /api/search`, `GET /api/notes/:id`, `GET /health`, y que las escrituras
   pasan solo por `/mcp`.
10. **Licencia** — Apache 2.0, una línea + enlace a `LICENSE`.
11. **Cooperar con el desarrollo** — enlace a `CONTRIBUTING.md`.

### D2 — Qué se va del README y a dónde (una sola fuente)

Todo el detalle de desarrollo sale del README a `CONTRIBUTING.md` (un solo archivo, no `docs/`):

| Contenido que sale del README | Dónde queda en `CONTRIBUTING.md` |
|---|---|
| clone + `bun i` + `prisma migrate deploy` + `bun run dev` | «Desarrollo local» |
| tests (`bun test`, `bun run typecheck`) | «Desarrollo local» |
| OpenSpec (cómo se especifican los cambios) | «OpenSpec» |
| importación (`bun run import`) | «Importar conocimiento existente» |
| decisiones de concurrencia interna (base compartida) | «Arquitectura y concurrencia» |
| stack/embeddings/RRF en detalle | «Arquitectura y concurrencia» |
| tabla de contextos de `DATABASE_URL` (incluida la base externa con `?sslmode=require`) | «Configuración de la base» |
| instalación con compose y base incluida (`git clone` + `docker compose up --build -d`) | «Instalación con Docker Compose (base incluida)» |
| fallos esperados del contenedor (tabla de `docker logs`) | «Fallos esperados del contenedor» |
| publicación de la imagen (workflow + `gh api` público) | «Publicar la imagen» |
| puente stdio (`mcp-proxy`) para clientes sin HTTP | «Clientes alternativos» |

Nada queda huérfano: cada bloque movido tiene su contraparte en `CONTRIBUTING.md` (tarea 2.2 lo
verifica con grep). El README conserva solo el resumen de 2-3 líneas de «cómo funciona» y la mención
de `DATABASE_URL` que ya está en la sección Docker.

### D3 — SVGs (2, hechos a mano, paleta neutra)

- `docs/assets/sin-vs-con-cortex.svg`: dos columnas — **sin Cortex** (el mismo pitfall se redescubre,
  las decisiones viven en chats/cabezas, la docs se desactualiza) vs **con Cortex** (una fuente de
  verdad sin git, curado con autor/app/kind, búsqueda léxica + semántica).
- `docs/assets/flujo-agente-cortex-postgres.svg`: `Agente (Hermes / Claude Code)` → `MCP (HTTP
  streamable, /mcp)` → `Cortex (Elysia + Bun)` → `Prisma` → `PostgreSQL 16 + pgvector`, con las
  superficies de lectura `/`, `/api` y `/health` al costado.
- Sin dependencias binarias nuevas: se escriben a mano como archivos `.svg` estáticos.
- Fondo propio (rect de fondo con fill propio) y paleta neutra que funcione en GitHub claro **y**
  oscuro; **no** se usa `prefers-color-scheme`.
- Terminados: sin texto desbordado ni cajas desalineadas. Verificado **visualmente** (renderizados en
  navegador o rasterizados), no leyendo el XML; la captura de cada SVG (o la razón concreta por la que
  no se pudo obtener) viaja en el handoff (tareas 3.3 y 3.4).

### D4 — No se inventa ningún comando

Todo comando que quede en el README se ejecuta tal cual. Fuente de verdad de la versión y del tag:
`package.json#version` (`0.2.0`) y `.github/workflows/publish.yml` (tags `latest` + `0.2.0`). El
comando de conexión usa `ghcr.io/jastorgalj/cortex:latest`.

### D5 — Sin captura de pantalla

La vista web `/` es una tabla de notas (solo lectura) sin valor de imagen; el usuario prefiere SVG.
Todo el material visual va en los dos SVGs de D3. No se agrega captura.

### D6 — Nota de seguridad (visible en la sección Docker)

El README nuevo invita a correr el contenedor; sin aviso alguien lo publica en internet sin saberlo.
La sección Docker lleva un `> Nota de seguridad` corto y visible: **no trae autenticación**, vive en
red interna/VPN, y si se expone, poner un proxy con auth delante. Es un hecho ya decidido en el repo
(el README viejo lo decía), no una opinión nueva.

### D7 — Aviso de primer arranque

El primer `docker run` descarga ~420 MB del modelo ONNX y el healthcheck arranca con
`start_period: 300s`: el usuario tiene que saber que puede tardar minutos y que `model_loaded: true`
es la señal. Va una línea en la sección Docker, no escondida entre líneas.

### D8 — Arquitectura soportada

La imagen se publica solo `linux/amd64`; en Apple Silicon corre emulada. Una línea en la sección
Docker para que nadie reporte «va lento» como bug.

## Non-Goals

- No se toca código, migraciones, `docker-compose.yml`, `Dockerfile`, `docker-entrypoint.sh`,
  `.env.example` ni `scripts/`.
- No se publica imagen, no se taguea, no se despliega.
- No se agrega multi-arch `arm64` (pendiente previo).
