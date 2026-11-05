#!/usr/bin/env bash
# Verifica que prisma/migrations reproduzca exactamente prisma/schema.prisma sobre una
# base VACÍA: prueba que el baseline está completo (extensiones, trigger FTS, índices).
# Crea una base temporal, aplica, comprueba, y la borra.
#
# Uso:  bash scripts/verify-initial-migration.sh
#       ADMIN_URL="postgresql://cortex:cortex_dev@127.0.0.1:5433/postgres" bash scripts/...
set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"

ADMIN_URL="${ADMIN_URL:-postgresql://cortex:cortex_dev@127.0.0.1:5433/postgres}"
FRESH_DB="${FRESH_DB:-cortex_verify}"
FRESH_URL="${ADMIN_URL%/*}/${FRESH_DB}"

echo "== base temporal $FRESH_DB =="
psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS $FRESH_DB;" -c "CREATE DATABASE $FRESH_DB;"

echo "== migrate deploy en base vacía =="
DATABASE_URL="$FRESH_URL" bunx prisma migrate deploy
DATABASE_URL="$FRESH_URL" bunx prisma migrate status | tail -3

echo "== drift vs datamodel (debe decir 'This is an empty migration') =="
bunx prisma migrate diff --from-url "$FRESH_URL" --to-schema-datamodel prisma/schema.prisma --script

echo "== objetos esperados =="
psql "$FRESH_URL" -tAc "
  select 'ext: '||string_agg(extname,' ' order by extname) from pg_extension
    where extname in ('vector','unaccent','pg_trgm')
  union all select 'trigger: '||tgname from pg_trigger
    where tgrelid='notes'::regclass and not tgisinternal
  union all select 'index: '||indexname from pg_indexes where tablename='notes' order by 1;"

echo "== FTS funcional (trigger + unaccent) =="
psql "$FRESH_URL" -tAc "
  insert into notes(id,title,body_md,app,kind,author)
    values ('01VERIFY','Módulo de préstamos','Revisión de tasación','general','sistema','verify');
  select 'fts ok: '||(fts is not null and fts @@ plainto_tsquery('spanish', unaccent('tasacion')))::text
    from notes where id='01VERIFY';"

echo "== limpieza =="
psql "$ADMIN_URL" -q -c "DROP DATABASE $FRESH_DB;"
echo "OK: el baseline reproduce el schema desde cero."
