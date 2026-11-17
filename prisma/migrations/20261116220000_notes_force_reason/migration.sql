-- Migración: agregar columna force_reason a notes
ALTER TABLE "notes" ADD COLUMN "force_reason" TEXT;
