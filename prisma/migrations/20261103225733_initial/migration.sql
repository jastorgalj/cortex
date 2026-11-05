-- ============================================================
-- Migración inicial — knowledge-mcp
-- SQL editado a mano (Decisión 1b y 3).
-- Prisma genera las tablas; extensiones, trigger FTS e índices
-- se declaran aquí manualmente.
-- ============================================================

-- Extensiones requeridas (Decisiones 1 y 3)
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "unaccent";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateTable
CREATE TABLE "notes" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body_md" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "author" TEXT NOT NULL,
    "issue" TEXT,
    "rev" INTEGER NOT NULL DEFAULT 1,
    "fts" tsvector,
    "embedding" vector(768),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_revisions" (
    "note_id" TEXT NOT NULL,
    "rev" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body_md" TEXT NOT NULL,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "author" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_revisions_pkey" PRIMARY KEY ("note_id","rev")
);

-- AddForeignKey
ALTER TABLE "note_revisions" ADD CONSTRAINT "note_revisions_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── FTS trigger (Decisión 3) ─────────────────────────────────────────────────
-- El trigger usa unaccent() directamente (válido en VOLATILE plpgsql) y
-- actualiza la columna fts en cada INSERT o UPDATE de title/body_md.
-- Evita el problema IMMUTABLE de columnas GENERATED ALWAYS con unaccent.

CREATE OR REPLACE FUNCTION notes_tsvector_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.fts := to_tsvector('spanish', unaccent(NEW.title || ' ' || NEW.body_md));
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER notes_fts_trigger
BEFORE INSERT OR UPDATE OF title, body_md ON notes
FOR EACH ROW EXECUTE FUNCTION notes_tsvector_update();

-- ─── Índices (Decisiones 3 y 5) ──────────────────────────────────────────────

-- GIN sobre fts para búsqueda léxica eficiente
CREATE INDEX "notes_fts_gin" ON "notes" USING GIN ("fts");

-- HNSW sobre embedding (coseno) — solo filas con embedding (índice parcial)
CREATE INDEX "notes_embedding_hnsw" ON "notes" USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL;

-- btree app y kind para filtros deterministas
CREATE INDEX "notes_app_idx" ON "notes" ("app");
CREATE INDEX "notes_kind_idx" ON "notes" ("kind");

-- btree deleted_at para exclusión eficiente de borrados lógicos
CREATE INDEX "notes_deleted_at_idx" ON "notes" ("deleted_at") WHERE "deleted_at" IS NOT NULL;

