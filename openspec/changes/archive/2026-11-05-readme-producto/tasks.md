# Tasks

Nota: los comandos de Docker (`docker pull` + `docker run -e DATABASE_URL` + `curl /health`) y el
instalador de skills (`curl .../scripts/install-skill.py` → `main`) ya se verificaron de punta a punta
en la exploración (salida: `{"status":"ok","notes":0,"model_loaded":true}`; script rc 0, 8419 bytes).
No se re-diagnostican; las tareas 1.2 y 4.2 solo comprueban que el README no los altere.

## 1. README.md reescrito (producto, Docker-only)

- [x] 1.1 Reescribir `README.md` con la estructura de `design.md` → D1 (11 secciones, español, tono
  producto). Verificar que cada sección está y en orden: `grep -nE '^## ' README.md` lista las 11.
- [x] 1.2 La sección «Empezar en dos minutos (Docker)» documenta `docker pull` +
  `docker run -d --name cortex -p 3091:3091 -e DATABASE_URL="postgresql://usuario:clave@host:5432/cortex"
  -v cortex-model-cache:/app/.model-cache --restart unless-stopped ghcr.io/jastorgalj/cortex:latest`
  y `curl http://localhost:3091/health` → `{"status":"ok","notes":0,"model_loaded":true}`. Verificar que
  el texto no altera la semántica de lo ya probado (misma imagen, mismo endpoint, mismo shape de
  respuesta que `src/index.ts:17-20`).
- [x] 1.3 «Cooperar con el desarrollo» enlaza a `CONTRIBUTING.md` con un link relativo (`[CONTRIBUTING.md](CONTRIBUTING.md)`),
  y ningún otro enlace/ancla del README apunta a una sección que se mudó. Verificar: `grep -nE '\]\(#' README.md`
  → cada ancla apunta a un `## ` que sigue existiendo en el README (o no hay anclas internas).
- [x] 1.4 El README **no** trae comandos de clonado ni del compose: la sección Docker cierra con una
  línea de puntero sin comandos («¿No tenés un Postgres a mano? El repo trae un compose con base
  incluida — ver `CONTRIBUTING.md`») y el camino `git clone` + `docker compose up --build -d` vive en
  `CONTRIBUTING.md` («Instalación con Docker Compose (base incluida)»). Verificar:
  `grep -n "git clone" README.md` → vacío y `grep -n "docker compose up" CONTRIBUTING.md` → presente.
- [x] 1.5 Nota de seguridad visible en la sección Docker (`> Nota de seguridad`): sin autenticación,
  para red interna/VPN, y si se expone, poner un proxy con auth delante. Verificar: `grep -n 'Nota de
  seguridad' README.md` → presente, con la frase «sin autenticación» o equivalente.
- [x] 1.6 Aviso de primer arranque en la sección Docker: la primera vez se descarga ~420 MB del modelo
  ONNX y puede tardar minutos; `model_loaded: true` es la señal de que quedó listo. Verificar:
  `grep -n 'model_loaded' README.md` → presente junto a la advertencia de descarga/tarda minutos.
- [x] 1.7 Línea de arquitectura soportada en la sección Docker: la imagen se publica solo
  `linux/amd64` y en Apple Silicon corre emulada. Verificar: `grep -n 'amd64' README.md` → presente.

## 2. CONTRIBUTING.md (una sola fuente del detalle de desarrollo)

- [x] 2.1 Crear `CONTRIBUTING.md` con los bloques de la tabla de `design.md` → D2: Desarrollo local
  (clone, `bun i`, `prisma migrate deploy`, `bun run dev`, `bun test`, `bun run typecheck`), Instalación
  con Docker Compose (base incluida), OpenSpec, Importar conocimiento existente, Arquitectura y
  concurrencia, Configuración de la base (con la fila de base externa `?sslmode=require`), Fallos
  esperados del contenedor, Publicar la imagen, Clientes alternativos (puente stdio).
- [x] 2.2 Nada queda huérfano: cada tema que sale del README (clone, `bun i`, `migrate deploy`, `bun
  test`, OpenSpec, `bun run import`, concurrencia/`base_rev`, publicación/`gh api`) aparece en
  `CONTRIBUTING.md`. Verificar con `grep -nE 'bun i|migrate deploy|bun test|bun run import|base_rev|gh api' CONTRIBUTING.md`
  → un match por tema, y `grep -nE 'bun i|migrate deploy|bun run import|base_rev|gh api' README.md` → vacío (salvo
  la mención `-e DATABASE_URL` de la sección Docker, que no es desarrollo).

## 3. SVGs (docs/assets/*.svg)

- [x] 3.1 Crear `docs/assets/sin-vs-con-cortex.svg`: comparativa dos columnas (sin Cortex vs con
  Cortex), fondo propio, paleta neutra para GitHub claro y oscuro, sin `prefers-color-scheme`.
- [x] 3.2 Crear `docs/assets/flujo-agente-cortex-postgres.svg`: agente → MCP → Cortex → Prisma →
  Postgres, con las superficies de lectura al costado. Mismos requisitos de fondo/paleta que 3.1.
- [x] 3.3 Referenciar ambos desde el README (secciones «Sin Cortex vs con Cortex» y «Cómo funciona»)
  con `![...](docs/assets/<nombre>.svg)`. Verificar que ambos `![...]` apuntan a un archivo que existe:
  `ls docs/assets/*.svg`.
- [x] 3.4 Verificar **visualmente** que cada SVG se ve terminado (sin texto desbordado ni cajas
  desalineadas): renderizarlo (abrir en navegador sobre `file://` o rasterizar) y adjuntar al handoff la
  captura de cada SVG, o la razón concreta por la que no se pudo obtener. No alcanza con leer el XML:
  el criterio 3.3 del pedido es «se ven terminados», y eso se comprueba mirando el render.

## 4. Verificación de cierre

- [x] 4.1 Enlaces y anclas: `grep -nE '\]\([^)]*\)' README.md` → todo enlace a archivo (`CONTRIBUTING.md`,
  `LICENSE`, `docs/assets/*.svg`) apunta a un archivo que existe en el worktree (`ls` de cada ruta), y
  ningún ancla interna (`#...`) apunta a una sección inexistente.
- [x] 4.2 Los comandos que quedan en el README corren tal cual (sin re-diagnosticar: `docker pull
  ghcr.io/jastorgalj/cortex:latest` rc 0 y `curl -fsSL .../scripts/install-skill.py` rc 0 ya verificados
  en la exploración; confirmar que el texto del README no los cambió).
- [x] 4.3 Baseline sin regresión: `bun run typecheck` (0 errores) y `bun test` (66 pass / 0 fail) — este
  change no toca código, así que el rojo no puede venir de acá; si aparece, reportar y no avanzar.
  → closer 2026-11-05: `bun run typecheck` rc=0; `bun test` → 66 pass / 0 fail, 203 expect, 6 archivos.
- [x] 4.4 `openspec validate readme-producto --type change --strict` → válido, sin errores ni warnings
  (con `skip_specs: true` imprime el INFO `skip_specs is set ... change declares no spec-level behavior changes`).
  → closer 2026-11-05: «Change 'readme-producto' is valid» rc=0 + el INFO de `skip_specs` esperado.

## Workflow follow-up

- Entregar por rama `docs/readme-producto` + PR a `main` (base `main`: el repo no tiene `develop`).
- `completion_contract: local-only` (repo público sin required status checks: ruleset con
  `required_approving_review_count: 0` y workflow `publish.yml` que solo dispara con tags).
- Push/PR con `GH_TOKEN="$(gh auth token --user jastorgalj)"`.
