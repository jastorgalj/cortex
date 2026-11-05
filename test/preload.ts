/**
 * test/preload.ts — Preload ejecutado por Bun antes de cada archivo de test.
 *
 * Garantía estructural: los tests usan SIEMPRE una DB local (`cortex_test`), nunca la
 * base del `.env` (que puede apuntar a Neon) ni la base de desarrollo compartida.
 * Este script:
 *   1. Crea `cortex_test` si no existe (idempotente — ignora "already exists").
 *   2. Aplica las migraciones Prisma contra `cortex_test` (no-op si ya aplicadas).
 *
 * La URL de test NO se deriva del `.env`: si el `.env` apunta a un Postgres remoto
 * (Neon u otro), los tests jamás deben escribir ahí. Host/puerto/credenciales salen de
 * constantes locales (las mismas del servicio `db` de docker-compose) y se pueden
 * sobreescribir con `TEST_DATABASE_URL` en el entorno del shell.
 */

import { SQL } from 'bun'

// ── 0. URL de la base de test (siempre local) ───────────────────────────────

/** Host local del Postgres de docker-compose, sin el nombre de la base. */
const LOCAL_HOST_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://cortex:cortex_dev@127.0.0.1:5433'

const TEST_DB = 'cortex_test'
// La base de mantenimiento existe siempre; se usa para poder crear `cortex_test`.
const adminUrl = `${LOCAL_HOST_URL}/postgres`
const testUrl = `${LOCAL_HOST_URL}/${TEST_DB}`

// Inyectar DATABASE_URL de test en el proceso actual para que PrismaClient
// en los archivos de test use cortex_test (complementa [test.env] en bunfig.toml)
process.env.DATABASE_URL = testUrl

// ── 1. Crear la DB de test si no existe ─────────────────────────────────────

const admin = new SQL(adminUrl)
try {
  await admin`CREATE DATABASE cortex_test`
  console.log('[preload] cortex_test creada.')
} catch (e: any) {
  // "already exists" es el caso normal en re-runs — no es un error
  if (!String(e.message ?? e).includes('already exists')) {
    console.error('[preload] Error creando cortex_test:', e)
    process.exit(1)
  }
  // DB ya existe — continuar normalmente
} finally {
  await admin.close()
}

// ── 2. Aplicar migraciones Prisma contra cortex_test ──────────────────────

const migrate = Bun.spawnSync(['bunx', 'prisma', 'migrate', 'deploy'], {
  cwd: process.cwd(),
  env: { ...process.env, DATABASE_URL: testUrl } as Record<string, string>,
  stdout: 'pipe',
  stderr: 'pipe',
})

const migrateOut = migrate.stdout.toString().trim()
const migrateErr = migrate.stderr.toString().trim()

if (migrate.exitCode !== 0) {
  console.error('[preload] prisma migrate deploy falló:')
  if (migrateOut) console.error(migrateOut)
  if (migrateErr) console.error(migrateErr)
  process.exit(1)
}

// Solo mostrar output si se aplicaron migraciones nuevas
if (migrateOut && !migrateOut.includes('No pending migrations')) {
  console.log('[preload] Migraciones aplicadas a cortex_test.')
}
