/**
 * test/health.test.ts — Tests de /health sin sonda de BD.
 *
 * El endpoint /health NUNCA toca la BD: devuelve siempre 200 con
 * { status:"ok", db_pool, model_loaded, sessions, uptime_s }.
 * db_pool:"idle"|"active" se determina por isPoolIdle(), sin queries.
 */
import { describe, test, expect } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { createApp } from '../src/index.ts'
import { rawPrisma } from '../src/db/client.ts'

const HEALTH_PORT = 13194
const BASE_URL = `http://localhost:${HEALTH_PORT}`

// ─── Siempre 200, sin tocar la BD ────────────────────────────────────────────

describe('GET /health — siempre 200, sin sonda de BD', () => {
  test('pool active → 200 con status:ok, db_pool:active, sin campo notes', async () => {
    const app = createApp({ isPoolIdle: () => false })
    app.listen(HEALTH_PORT)
    try {
      const r = await fetch(`${BASE_URL}/health`)
      expect(r.status).toBe(200)
      const body = (await r.json()) as Record<string, unknown>
      expect(body.status).toBe('ok')
      expect(body.db_pool).toBe('active')
      expect(body.notes).toBeUndefined()
      expect(typeof body.uptime_s).toBe('number')
    } finally {
      app.stop()
    }
  })

  test('pool idle → 200 con status:ok, db_pool:idle, sin campo notes', async () => {
    const app = createApp({ isPoolIdle: () => true })
    app.listen(HEALTH_PORT)
    try {
      const r = await fetch(`${BASE_URL}/health`)
      expect(r.status).toBe(200)
      const body = (await r.json()) as Record<string, unknown>
      expect(body.status).toBe('ok')
      expect(body.db_pool).toBe('idle')
      expect(body.notes).toBeUndefined()
    } finally {
      app.stop()
    }
  })

  test('sin isPoolIdle → 200 (default: usa idleDisconnect.isIdle())', async () => {
    const app = createApp()
    app.listen(HEALTH_PORT)
    try {
      const r = await fetch(`${BASE_URL}/health`)
      expect(r.status).toBe(200)
      const body = (await r.json()) as Record<string, unknown>
      expect(body.status).toBe('ok')
      expect(['idle', 'active']).toContain(body.db_pool as string)
    } finally {
      app.stop()
    }
  })
})

// ─── Cambio de estado del pool entre requests ─────────────────────────────────

const IDLE_PORT = 13195
const IDLE_URL = `http://localhost:${IDLE_PORT}`

describe('GET /health — cambio de isPoolIdle entre requests', () => {
  test('true → false: primera 200 db_pool:idle, segunda 200 db_pool:active', async () => {
    let idle = true
    const app = createApp({ isPoolIdle: () => idle })
    app.listen(IDLE_PORT)
    try {
      const r1 = await fetch(`${IDLE_URL}/health`)
      expect(r1.status).toBe(200)
      const b1 = (await r1.json()) as Record<string, unknown>
      expect(b1.db_pool).toBe('idle')

      idle = false

      const r2 = await fetch(`${IDLE_URL}/health`)
      expect(r2.status).toBe(200)
      const b2 = (await r2.json()) as Record<string, unknown>
      expect(b2.db_pool).toBe('active')
      expect(b2.notes).toBeUndefined()
    } finally {
      app.stop()
    }
  })

  test('3 requests seguidas → 3 × 200, db_pool consistente con isPoolIdle', async () => {
    const app = createApp({ isPoolIdle: () => true })
    app.listen(IDLE_PORT)
    try {
      for (let i = 0; i < 3; i++) {
        const r = await fetch(`${IDLE_URL}/health`)
        expect(r.status).toBe(200)
        const body = (await r.json()) as Record<string, unknown>
        expect(body.status).toBe('ok')
        expect(body.db_pool).toBe('idle')
        expect(body.notes).toBeUndefined()
      }
    } finally {
      app.stop()
    }
  })
})

// ─── /health no llama a la BD (prisma envenenado) ────────────────────────────
//
// Usamos un Proxy que lanza si se accede a cualquier propiedad.
// Si el handler de /health toca `db` (prisma inyectado), la excepción
// convierte el 200 en 500 y el test falla. Cubre criterios 1 y 9.

const POISON_PORT = 13197
const POISON_URL = `http://localhost:${POISON_PORT}`

function makePoisonedPrisma(): import('@prisma/client').PrismaClient {
  return new Proxy({} as import('@prisma/client').PrismaClient, {
    get(_target, prop) {
      throw new Error(`/health tocó la BD — propiedad '${String(prop)}' no debe llamarse`)
    },
  })
}

describe('GET /health — no toca la BD (prisma envenenado)', () => {
  test('pool idle, 3 requests → 200 sin excepción (handler nunca accede al prisma)', async () => {
    const app = createApp({ isPoolIdle: () => true, _prismaForTest: makePoisonedPrisma() })
    app.listen(POISON_PORT)
    try {
      for (let i = 0; i < 3; i++) {
        const r = await fetch(`${POISON_URL}/health`)
        expect(r.status).toBe(200)
        const body = (await r.json()) as Record<string, unknown>
        expect(body.db_pool).toBe('idle')
      }
    } finally {
      app.stop()
    }
  })

  test('pool active, 3 requests → 200 sin excepción (handler nunca accede al prisma)', async () => {
    const app = createApp({ isPoolIdle: () => false, _prismaForTest: makePoisonedPrisma() })
    app.listen(POISON_PORT)
    try {
      for (let i = 0; i < 3; i++) {
        const r = await fetch(`${POISON_URL}/health`)
        expect(r.status).toBe(200)
        const body = (await r.json()) as Record<string, unknown>
        expect(body.db_pool).toBe('active')
      }
    } finally {
      app.stop()
    }
  })
})

// ─── /health no toca la BD (pg_stat_activity) ────────────────────────────────
//
// Con el singleton rawPrisma desconectado, medimos las conexiones activas en
// pg_stat_activity antes y después de N requests /health.
// Si el handler toca prisma/rawPrisma del módulo, una nueva conexión aparece.
// Este test detecta sondas vía singleton (que el proxy envenenado no ve).

const PG_STAT_PORT = 13198
const PG_STAT_URL = `http://localhost:${PG_STAT_PORT}`

describe('GET /health — no toca la BD (pg_stat_activity)', () => {
  test('3 requests idle + 3 requests active → 0 conexiones nuevas en pg_stat_activity', async () => {
    // 1. Dejar rawPrisma desconectado (estado conocido, 0 conexiones del singleton)
    await rawPrisma.$connect()
    await rawPrisma.$disconnect()
    await Bun.sleep(300)

    // 2. Cliente auxiliar para medir conexiones; usa DATABASE_URL del preload (cortex_test)
    const monitor = new PrismaClient()
    type CountRow = { count: number }
    const measure = async (): Promise<number> => {
      const rows = await monitor.$queryRaw<CountRow[]>`
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()`
      return rows[0].count
    }

    const before = await measure()

    // 3. /health x3 con pool idle, x3 con pool active — ninguno debe tocar la BD
    for (const idle of [true, false]) {
      const app = createApp({ isPoolIdle: () => idle })
      app.listen(PG_STAT_PORT)
      try {
        for (let i = 0; i < 3; i++) {
          const r = await fetch(`${PG_STAT_URL}/health`)
          expect(r.status).toBe(200)
        }
      } finally {
        app.stop()
      }
      await Bun.sleep(100)
    }

    // Dar tiempo a que PG registre eventuales conexiones tardías
    await Bun.sleep(300)
    const after = await measure()

    // Si /health toca la BD (prisma o rawPrisma del módulo) after > before
    expect(after).toBe(before)

    await monitor.$disconnect()
  })
})
