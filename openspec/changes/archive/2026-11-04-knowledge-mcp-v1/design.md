# Design

## Decisión 1 — Postgres gestionado con pgvector, provider-agnóstico

El usuario eligió Postgres (gate 2026-11-04, segunda ronda): permite una DB centralizada sin
administrar volúmenes y es el motor que el equipo ya opera a diario. Decisión: **el código es
agnóstico al proveedor** (solo exige PG ≥ 16 con `vector`, `unaccent` y `pg_trgm`) y la base es
**propia de este proyecto**, con su propio proyecto y credenciales, sin reutilizar la DB de ningún
otro sistema. El deploy inicial usa **Neon free tier** (pgvector disponible hoy, el corpus son
megabytes) y migrar a otro Postgres es `pg_dump | pg_restore` + cambiar `DATABASE_URL` — cero cambio
de código. Dev y tests corren contra la imagen `pgvector/pgvector` en docker-compose. El proyecto
Neon del deploy está validado (PG 18.6, extensiones `vector` 0.8.6, `unaccent` y `pg_trgm`
disponibles) y su cadena de conexión se guarda fuera del repo: en deploy se inyecta como
`DATABASE_URL`, nunca se commitea. Trade-off aceptado de Neon: el conocimiento vive en un SaaS
externo y la primera query tras autosuspend tarda ~1s. Backup: PITR de Neon; con otro Postgres,
`pg_dump` programado.

## Decisión 1b — ORM: Prisma

Decisión del usuario (2026-11-04): el acceso a datos usa **Prisma** (schema.prisma + prisma
migrate + Prisma Client), el ORM que el equipo ya domina. Límites conocidos y cómo se cubren:
pgvector y tsvector no tienen tipo nativo en Prisma — la columna `embedding` se declara
`Unsupported("vector(768)")`, la columna generada `fts` y los índices GIN/HNSW y
`CREATE EXTENSION` van en el SQL de las migraciones (prisma migrate acepta SQL editado a mano),
y las queries de búsqueda (full-text, coseno) usan `$queryRaw` tipado. El CRUD, las revisiones
y los filtros usan Prisma Client normal. Prisma corre bien bajo Bun (`bunx prisma generate` /
`migrate`).

## Decisión 2 — Versionado por tabla de revisiones, no git

El usuario descartó git (gate 2026-11-04, opción C). Lo que git daba y hay que conservar:
historial (quién, cuándo, qué decía antes) y recuperación. Lo cubre `note_revisions`
append-only: cada `kb_update` inserta la versión ANTERIOR completa antes de modificar la nota.
No hay merge ni ramas porque no hay réplicas que divergir — una sola DB. Lo que se pierde de
git y se acepta perder: edición offline y review por MR.

## Decisión 3 — Esquema

```sql
notes(id TEXT PK,            -- ulid
      title TEXT NOT NULL,
      body_md TEXT NOT NULL,
      app TEXT NOT NULL,      -- 'cartera', 'huella', 'general', ...
      kind TEXT NOT NULL,     -- enum: sistema|flujo|decision|pitfall|regla|otro
      tags JSONB NOT NULL,
      author TEXT NOT NULL,
      issue TEXT,             -- 'CAR-287', '#134', URL — formato libre
      rev INTEGER NOT NULL,   -- revisión vigente, para base_rev
      fts tsvector GENERATED ALWAYS AS
          (to_tsvector('spanish', unaccent(title || ' ' || body_md))) STORED,
      embedding vector(768),  -- pgvector, normalizado
      created_at timestamptz, updated_at timestamptz,
      deleted_at timestamptz) -- borrado lógico
note_revisions(note_id, rev INTEGER, title, body_md, tags, author, reason, created_at)
-- índices: GIN sobre fts; HNSW (vector_cosine_ops) sobre embedding; btree app/kind
```

Nota sobre `unaccent` en columna generada: la función base no es IMMUTABLE — usar el wrapper
inmutable estándar (función SQL propia que fija el diccionario) o calcular el tsvector por
trigger. Decisión del implementador, el requisito es búsqueda insensible a tildes.

El esquema de arriba es ilustrativo del SQL final: la fuente de verdad es `prisma/schema.prisma`
(Decisión 1b), con `embedding` como `Unsupported("vector(768)")` y la columna `fts`, extensiones
e índices GIN/HNSW declarados en el SQL de las migraciones de prisma migrate.

## Decisión 3b — Taxonomía estructurada y frontera con las skills

`app` y `kind` son columnas obligatorias, no tags: la clasificación libre degenera (fricción
medida del repo git anterior: «¿dónde pongo esto?»). El enum de `kind` es cerrado y chico.
Frontera escrita con el resto del ecosistema: el CÓMO procedural de los agentes vive en skills
de Hermes (doctrina de la fábrica); los invariantes de un repo viven en su AGENTS.md (se cargan
solos con el código). Este KB guarda lo demás: hechos de sistemas, flujos, decisiones con su
porqué, pitfalls y reglas de negocio. Sin jerarquía de carpetas: la organización es
búsqueda + facetas (`app`, `kind`, tags).

## Decisión 3c — Concurrencia

Postgres maneja la concurrencia física (MVCC); el server sigue siendo un solo proceso Bun. El
conflicto lógico (dos agentes leen la misma nota y ambos actualizan) se maneja con `base_rev`
opcional en `kb_update`: si la revisión vigente ya no es la leída, el servidor rechaza y el
agente relee y fusiona. Sin `base_rev` aplica last-writer-wins y la versión pisada queda en
`note_revisions`. El par revisión+update corre en una transacción.

## Decisión 4 — Embeddings: mismo modelo que el fork de bitacora

`Xenova/all-mpnet-base-v2` (768 dim, ONNX local vía @huggingface/transformers, sin API key).
Razón: los umbrales ya están medidos sobre el contenido real del equipo en ese modelo
(≥ 0.44 hit sólido, ≥ 0.55 duplicado, < 0.25 ruido) y el contenido es el mismo que se importa.
Cambiar a un modelo multilingüe (p. ej. multilingual-e5) queda como mejora futura con
re-medición de umbrales; cambiar el modelo invalida todos los vectores (rebuild completo).
Pitfalls vigentes aquí: vectores normalizados antes de insertar (coseno estable),
`dtype: 'fp32'` para silenciar el warning del pipeline, cache del modelo fuera de node_modules.
Los pitfalls de sqlite-vec documentados en el fork (rowid BigInt, DELETE+INSERT) no aplican con
pgvector.

## Decisión 5 — Búsqueda híbrida con fusión RRF

`kb_search` corre el full-text de Postgres (`ts_rank` sobre config spanish + unaccent) y los
vecinos por coseno (pgvector) en paralelo y fusiona por Reciprocal Rank Fusion (k=60,
estándar). Los resultados semánticos con score < 0.25 se descartan antes de la fusión (ruido
medido). Razón de la fusión en vez de solo-semántico: los identificadores exactos (símbolos,
códigos de ticket, nombres de campo) los gana el full-text; los conceptos en lenguaje natural
los gana el vector — el contenido del equipo mezcla ambos.

## Decisión 6 — Duplicados: el servidor avisa, el agente decide

`kb_write` calcula el embedding ANTES de insertar y busca similares ≥ 0.55. Si hay, NO crea la
nota: responde `status: "similar_exists"` con las candidatas (id, título, score) y la
instrucción de usar `kb_update` sobre la existente o reintentar con `force: true`. Razón: en el
flujo git anterior la deduplicación automática silenciosa actualizaba archivos equivocados; la
decisión es del agente que tiene el contexto, no del servidor.

## Decisión 7 — Transporte MCP: HTTP streamable, un solo proceso

SDK oficial `@modelcontextprotocol/sdk` montado en Elysia (Bun) en `/mcp`. Sin modo stdio en el
servidor: es un servicio central, no un binario local. Los clientes que solo hablan stdio
(configs viejas de Hermes/Claude) usan `mcp-proxy` local apuntando a la URL — patrón ya usado
por el equipo. La vista web de solo lectura y el healthcheck (`GET /health`) viven en el mismo
proceso Elysia.

## Decisión 8 — Autoría declarativa, sin auth

Decisión del usuario (red interna/VPN). Toda tool de escritura exige `author` no vacío y el
servidor lo persiste tal cual. Riesgo aceptado y escrito: cualquiera en la red puede escribir
con cualquier nombre; con 5-10 personas de confianza el costo de un esquema de tokens supera
hoy su beneficio. Si el equipo crece o el servidor sale de la VPN, auth es el primer cambio.

## Decisión 9 — Importación inicial como comando, no como servicio

`bun run import -- <ruta>` acepta dos formas de fuente y puede invocarse varias veces:
(1) un clon de `novara-knowledge` — recorre `sistemas/**/*.md` y `.bitacora/learnings/*.md`
(excluyendo `status: superseded`); (2) un repo de código con `.bitacora/learnings/` — recorre solo
esos learnings, con `app` inferida del nombre del repo. En ambos casos crea una nota por
archivo con `author` = autor del frontmatter o del último commit git del archivo, tag por
carpeta de origen, e `issue` si el frontmatter lo trae. Idempotente por path de origen (tag
`origen:<repo>:<path>`): re-ejecutar no duplica. Corre en el deploy inicial sobre
novara-knowledge y sobre cada repo de código con learnings commiteados (backend, frontend,
etc.); no queda ningún proceso mirando los repos viejos.
