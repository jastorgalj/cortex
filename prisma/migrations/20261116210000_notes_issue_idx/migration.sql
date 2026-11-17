-- Índice funcional sobre lower(btrim(issue)) — escrito a mano (Prisma no expresa índices funcionales).
CREATE INDEX "notes_issue_idx" ON "notes" (lower(btrim("issue")));
