#!/usr/bin/env bash
# Entrypoint de Cortex: aplica las migraciones pendientes y arranca el servidor.
# Un `docker run` autosuficiente solo necesita `-e DATABASE_URL=...`.
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "error: DATABASE_URL no está definida." >&2
  echo "Cortex necesita un PostgreSQL 16 con pgvector accesible." >&2
  echo "Pasá la URL con: -e DATABASE_URL=postgresql://usuario:clave@host:5432/cortex" >&2
  exit 1
fi

echo "[cortex] Aplicando migraciones pendientes (migrate deploy)…"
if ! bun run db:migrate; then
  echo "error: no se pudieron aplicar las migraciones." >&2
  echo "Revisá DATABASE_URL: debe apuntar a un PostgreSQL 16 con pgvector accesible" >&2
  echo "(conexión imposible, permisos insuficientes o extensión vector faltante)." >&2
  exit 1
fi

echo "[cortex] Migraciones al día. Arrancando el servidor…"
exec "$@"
