# Tasks

## 1. Núcleo — proyecto, esquema y CRUD de notas

- [x] 1.1 Scaffold del proyecto: Bun + Elysia + TypeScript estricto, **Prisma** (schema.prisma
      + prisma migrate + Prisma Client), docker-compose de dev con servicio `db` (imagen
      `pgvector/pgvector:pg16`, volumen), estructura `src/{db,tools,web}/`, `bun test`
      configurado contra la DB del compose — verificar con `bunx tsc --noEmit`, `bunx prisma
      migrate dev` aplicando limpio y un test trivial en verde
- [x] 1.2 Esquema de la Decisión 3 como `prisma/schema.prisma` (incluye `app`, `kind`, `rev`;
      `embedding` como `Unsupported("vector(768)")`) + SQL de migración editado a mano con
      `CREATE EXTENSION IF NOT EXISTS vector/unaccent/pg_trgm`, la columna `fts` tsvector
      spanish insensible a tildes e índices GIN + HNSW — test: `prisma migrate deploy` sobre
      una DB limpia aplica sin error y re-aplicarlo es no-op
- [x] 1.3 Repositorio de notas (`src/db/notes.ts`, Prisma Client; `$queryRaw` solo donde Prisma
      no llega): create (valida author/app/kind, enum cerrado), read, update (inserta la
      revisión ANTERIOR en `note_revisions` antes de modificar, en la misma transacción
      `$transaction`; `base_rev` opcional rechaza si no coincide con `rev` vigente), list con
      filtros app/kind/tag/author, soft delete, history — tests por operación, incluidos:
      update de nota inexistente → error, dos updates → revisiones 1 y 2, `base_rev`
      desactualizada → rechazo informando la rev vigente, `kind` fuera del enum → rechazo
      nombrando los valores válidos
- [x] 1.4 Búsqueda léxica: full-text spanish sobre título + cuerpo, insensible a tildes — test:
      la query con y sin tildes («evaluación»/«evaluacion») encuentra la misma nota; nota
      borrada (soft) desaparece de los resultados

## 2. Búsqueda híbrida y duplicados

- [x] 2.1 Pipeline de embeddings (`src/db/embeddings.ts`): `Xenova/all-mpnet-base-v2` vía
      @huggingface/transformers con `{ dtype: 'fp32' }`, vectores normalizados antes de
      insertar, cache del modelo fuera de node_modules, escritura de la columna `embedding`
      vía `$executeRaw` (tipo `Unsupported` en Prisma)
- [x] 2.2 `kb_search` híbrido: full-text + semántico en paralelo (`$queryRaw` tipado para
      ambas ramas), descarte semántico < 0.25, fusión RRF k=60, respuesta con id, título,
      snippet, score y origen (lexical/semantic/both) — test con fixture de ≥ 20 notas: una
      query por identificador exacto la gana la léxica, una query conceptual en español trae
      la nota correcta en el top 3
- [x] 2.3 Detección de duplicados en `kb_write`: similares ≥ 0.55 → `status: "similar_exists"`
      + candidatas, sin insertar; `force: true` inserta igual — test de los tres caminos
      (sin similar, con similar sin force, con similar con force)
- [x] 2.4 Embedding de la nota al crear/actualizar en el mismo flujo de escritura (síncrono: el
      volumen es bajo y el modelo ya está cargado en memoria) — test: nota recién creada es
      encontrable semánticamente sin paso de reindexado

## 3. Servidor MCP, vista web e importación

- [x] 3.1 Montar `@modelcontextprotocol/sdk` (transporte HTTP streamable) en Elysia bajo `/mcp`
      con las seis tools: `kb_search`, `kb_read`, `kb_write`, `kb_update`, `kb_list`,
      `kb_history`; toda tool de escritura rechaza `author` vacío con mensaje que dice qué
      falta — test de integración: cliente MCP real (SDK) conecta, `tools/list` devuelve
      exactamente las seis, y un ciclo write→search→read→update→history funciona de punta a
      punta
- [x] 3.2 Vista web de solo lectura en el mismo proceso: `GET /` lista (título, tags, autor,
      fecha, ordenado por updated_at desc) y `GET /notes/:id` renderiza el markdown; más la API
      REST de solo lectura `GET /api/search` y `GET /api/notes/:id` (JSON, mismos resultados
      que las tools) — test: POST/PUT/PATCH/DELETE fuera de `/mcp` responden 404/405 y
      `/api/search?q=…` devuelve los mismos ids que `kb_search`
- [x] 3.3 `GET /health` → `{status:"ok", notes:N, model_loaded:bool}` — usado por el
      healthcheck de compose
- [x] 3.4 Importador (`bun run import -- <ruta>`), con dos formas de fuente: (a) clon de
      novara-knowledge → `sistemas/**/*.md` + `.bitacora/learnings/*.md`, excluye
      `status: superseded`, `app` inferida del path (`sistemas/cartera/**` → `cartera`;
      resto → `general`), `kind` inferida (`sistemas/**` → `sistema`; learnings → `pitfall` o
      `decision` según frontmatter, default `pitfall`); (b) repo de código → solo sus
      `.bitacora/learnings/*.md`, `app` inferida del nombre del repo. Tag
      `origen:<repo>:<path-relativo>`, idempotente por ese tag — tests con fixtures de ambas
      formas: segunda corrida no duplica; corridas reales contra
      `/srv/repos/novara-knowledge` y contra los repos de código con
      learnings (p. ej. `nucleo-core/backend`, `nucleo-core/frontend`) documentadas en el
      handoff con conteos por fuente
- [x] 3.5 Dockerfile del server (imagen Bun; sin datos locales salvo el cache del modelo ONNX
      en volumen) + docker-compose.yml (server + `db` pgvector para dev, `DATABASE_URL` por
      env, healthcheck sobre `/health`) — verificar con `docker compose up` local: `/health`
      responde y las tools MCP contestan desde el contenedor contra la DB del compose
- [x] 3.6 README: qué es, cómo se levanta, cómo se conecta un agente (URL directa y bridge
      mcp-proxy para clientes stdio), contrato de las seis tools con ejemplos, y la política
      sin-auth con su porqué

## 4. Validación general — solo al cierre

- [x] 4.1 Suite completa `bun test` en verde + typecheck + `docker compose up` con ciclo MCP
      end-to-end contra el contenedor (no contra el proceso local)
- [x] 4.2 Importación real completa del repo novara-knowledge y 5 búsquedas de humo sobre
      contenido conocido (p. ej. «tasa especial», «perfiles del sistema») con la nota esperada
      en el top 3 — conteos y resultados en el handoff
- [x] 4.3 Reconciliar este tasks.md antes de archivar el change

## Workflow follow-up (orquestador, fuera de las cards)

- El proyecto Neon free del proyecto está validado (PG 18.6, `vector` 0.8.6 disponible); su
  cadena de conexión se guarda fuera del repo y en deploy se inyecta como `DATABASE_URL`.
  Nunca se commitea ni se usa para desarrollo (dev corre contra el compose).
- Para migrar a otro Postgres: `pg_dump | pg_restore` + cambio de `DATABASE_URL`, y verificar
  las 5 búsquedas de humo.
- Pedir al usuario la URL del remoto cuando exista y el host de deploy del server;
  hasta entonces el repo es local y el deploy queda en `docker compose up` manual.
- Tras el deploy: configurar el MCP en los agentes del equipo y congelar escrituras al repo
  git `novara-knowledge` (aviso al equipo).
