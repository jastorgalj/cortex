/**
 * test/preload.ts — Preload ejecutado por Bun antes de cada archivo de test.
 *
 * Garantía estructural: los tests usan la DB `cortex_test`, nunca `cortex`.
 * Este script:
 *   1. Crea `cortex_test` si no existe (idempotente — ignora "already exists").
 *   2. Aplica las migraciones Prisma contra `cortex_test` (no-op si ya aplicadas).
 *
 * No depende de variables de entorno inyectadas por [test.env] porque el preload
 * se ejecuta antes de que Bun inyecte esas variables. Lee .env directamente para
 * obtener la URL de la DB principal y deriva la URL de test reemplazando el DB name.
 */

import { SQL } from 'bun'
import { readFileSync } from 'fs'
import { join } from 'path'

// ── 0. Leer la URL de la DB principal desde .env ─────────────────────────────

function readDotEnv(): Record<string, string> {
  try {
    const envPath = join(process.cwd(), '.env')
    const content = readFileSync(envPath, 'utf8')
    const result: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      result[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
    return result
  } catch {
    return {}
  }
}

const dotEnv = readDotEnv()
// URL de la DB de desarrollo (apunta a cortex)
const adminUrl = dotEnv.DATABASE_URL ?? process.env.DATABASE_URL ?? ''
if (!adminUrl) {
  console.error('[preload] DATABASE_URL no encontrado en .env')
  process.exit(1)
}

// URL de la DB de test: mismo host/user/pass, distinto DB name
const TEST_DB = 'cortex_test'
const urlParts = adminUrl.match(/^(postgresql:\/\/.+@[^/]+\/)([^?]+)(.*)$/)
if (!urlParts) {
  console.error('[preload] No se pudo parsear DATABASE_URL:', adminUrl)
  process.exit(1)
}
const testUrl = `${urlParts[1]}${TEST_DB}${urlParts[3]}`

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
