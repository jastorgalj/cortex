/**
 * test/health.test.ts — Tests de /health con timeout y sondeo único (grupo 2).
 *
 * Usa createApp({ countNotes }) para inyectar el sondeo sin tocar la BD real
 * (las rutas de producto no se modifican). El reloj se inyecta donde hace falta
 * probando createHealthProbe directamente.
 */
import { describe, test, expect } from 'bun:test'
import { createApp } from '../src/index.ts'
import { createHealthProbe } from '../src/health.ts'

const PROBE_PORT = 13194
const BASE_URL = `http://localhost:${PROBE_PORT}`

// ─── 503 con BD caída ─────────────────────────────────────────────────────────

describe('GET /health — BD caída', () => {
  test('countNotes que rechaza → 503 con db:"down" y sin el host de la excepción', async () => {
    const countNotes = async (): Promise<number> => {
      throw new Error('connect ECONNREFUSED db.ejemplo.interno:5432')
    }
    const app = createApp({ countNotes })
    app.listen(PROBE_PORT)
    try {
      const r = await fetch(`${BASE_URL}/health`)
      expect(r.status).toBe(503)
      const body = (await r.json()) as Record<string, unknown>
      expect(body.status).toBe('degraded')
      expect(body.db).toBe('down')
      expect(body.error).toBe('base de datos no disponible')
      const raw = JSON.stringify(body)
      expect(raw).not.toContain('db.ejemplo.interno')
      expect(raw).not.toContain('5432')
    } finally {
      app.stop()
    }
  })

  test('countNotes que no resuelve → 503 en < 5 s', async () => {
    const countNotes = (): Promise<number> => new Promise<number>(() => {})
    const app = createApp({ countNotes })
    app.listen(PROBE_PORT)
    try {
      const t0 = performance.now()
      const r = await fetch(`${BASE_URL}/health`)
      const elapsed = performance.now() - t0
      expect(r.status).toBe(503)
      const body = (await r.json()) as Record<string, unknown>
      expect(body.db).toBe('down')
      expect(elapsed).toBeLessThan(5000)
    } finally {
      app.stop()
    }
  })

  test('20 requests simultáneas con countNotes colgado → countNotes llamado 1 vez', async () => {
    let calls = 0
    const countNotes = (): Promise<number> => {
      calls++
      return new Promise<number>(() => {})
    }
    const app = createApp({ countNotes })
    app.listen(PROBE_PORT)
    try {
      const requests = Array.from({ length: 20 }, () => fetch(`${BASE_URL}/health`))
      const responses = await Promise.all(requests)
      for (const r of responses) expect(r.status).toBe(503)
      expect(calls).toBe(1)
    } finally {
      app.stop()
    }
  })

  test('con countNotes que luego resuelve → la siguiente request lanza sondeo nuevo (calls===2)', async () => {
    let calls = 0
    let resolveFirst: ((n: number) => void) | null = null
    const countNotes = (): Promise<number> => {
      calls++
      if (calls === 1) {
        return new Promise<number>((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve(42)
    }
    const app = createApp({ countNotes })
    app.listen(PROBE_PORT)
    try {
      // Primera request: cuelga 3 s (timeout del probe) → 503
      const first = await fetch(`${BASE_URL}/health`)
      expect(first.status).toBe(503)

      // El sondeo pendiente ahora resuelve; .finally() limpia probePromise como microtask
      expect(resolveFirst).not.toBeNull()
      resolveFirst!(7)

      // La I/O de red (macrotask) llega al servidor solo después de que las microtasks
      // drenaron: .finally() ya corrió y probePromise es null → nuevo sondeo (calls===2)
      const second = await fetch(`${BASE_URL}/health`)
      expect(second.status).toBe(200)
      const body = (await second.json()) as { status: string; notes: number }
      expect(body.status).toBe('ok')
      expect(body.notes).toBe(42)   // call 2 → Promise.resolve(42)
      expect(calls).toBe(2)
    } finally {
      app.stop()
    }
  })

  test('sano → BD cae → 503 inmediato (no cachea probe resuelto)', async () => {
    let shouldFail = false
    const countNotes = (): Promise<number> => {
      if (shouldFail) return Promise.reject(new Error('connection refused'))
      return Promise.resolve(10)
    }
    const app = createApp({ countNotes })
    app.listen(PROBE_PORT)
    try {
      // BD sana → 200
      const r1 = await fetch(`${BASE_URL}/health`)
      expect(r1.status).toBe(200)
      const b1 = (await r1.json()) as { status: string; notes: number }
      expect(b1.notes).toBe(10)

      // BD cae; probePromise ya es null (se limpió al asentarse)
      shouldFail = true

      // Siguiente request: probe nuevo → rechaza → 503 inmediato (no hay caché ok)
      const r2 = await fetch(`${BASE_URL}/health`)
      expect(r2.status).toBe(503)
      const b2 = (await r2.json()) as { db: string }
      expect(b2.db).toBe('down')
    } finally {
      app.stop()
    }
  })
})

// ─── Sondeo con reloj inyectado ──────────────────────────────────────────────

describe('createHealthProbe — sondeo con reloj inyectado', () => {
  test('sondeo pendiente 31 s → llamada nueva', async () => {
    let calls = 0
    let fakeNow = 1000
    const countNotes = (): Promise<number> => {
      calls++
      return new Promise<number>(() => {}) // siempre cuelga
    }
    const probe = createHealthProbe({
      countNotes,
      timeoutMs: 10,
      staleMs: 30000,
      now: () => fakeNow,
    })

    const r1 = await probe()
    expect(r1.ok).toBe(false)
    expect(calls).toBe(1)

    // Avanzamos el reloj 31 s → el sondeo pendiente se considera obsoleto
    fakeNow = 1000 + 31_000
    const r2 = await probe()
    expect(r2.ok).toBe(false)
    expect(calls).toBe(2)
  })
})

// ─── isPoolIdle (task 3.4) ───────────────────────────────────────────────────

const IDLE_PORT = 13195
const IDLE_URL = `http://localhost:${IDLE_PORT}`

describe('GET /health — isPoolIdle: true (pool idle)', () => {
  test('3 GET /health → 3 × 200 con db_pool:idle, sin notes, countNotes 0 llamadas', async () => {
    let countNotesCalls = 0
    const countNotes = async (): Promise<number> => { countNotesCalls++; return 0 }
    const app = createApp({ countNotes, isPoolIdle: () => true })
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
      expect(countNotesCalls).toBe(0)
    } finally {
      app.stop()
    }
  })
})

describe('GET /health — isPoolIdle: false (pool active)', () => {
  test('GET /health → 200 con db_pool:active y notes, countNotes 1 llamada', async () => {
    let countNotesCalls = 0
    const countNotes = async (): Promise<number> => { countNotesCalls++; return 5 }
    const app = createApp({ countNotes, isPoolIdle: () => false })
    app.listen(IDLE_PORT)
    try {
      const r = await fetch(`${IDLE_URL}/health`)
      expect(r.status).toBe(200)
      const body = (await r.json()) as Record<string, unknown>
      expect(body.status).toBe('ok')
      expect(body.db_pool).toBe('active')
      expect(body.notes).toBe(5)
      expect(countNotesCalls).toBe(1)
    } finally {
      app.stop()
    }
  })
})

describe('GET /health — cambio de isPoolIdle entre requests', () => {
  test('true → false: segunda request consulta la BD', async () => {
    let idle = true
    let countNotesCalls = 0
    const countNotes = async (): Promise<number> => { countNotesCalls++; return 7 }
    const app = createApp({ countNotes, isPoolIdle: () => idle })
    app.listen(IDLE_PORT)
    try {
      // Primera: idle=true → db_pool:idle, sin consultar BD
      const r1 = await fetch(`${IDLE_URL}/health`)
      expect(r1.status).toBe(200)
      const b1 = (await r1.json()) as Record<string, unknown>
      expect(b1.db_pool).toBe('idle')
      expect(countNotesCalls).toBe(0)

      // Cambiar a active
      idle = false

      // Segunda: idle=false → db_pool:active, BD consultada
      const r2 = await fetch(`${IDLE_URL}/health`)
      expect(r2.status).toBe(200)
      const b2 = (await r2.json()) as Record<string, unknown>
      expect(b2.db_pool).toBe('active')
      expect(b2.notes).toBe(7)
      expect(countNotesCalls).toBe(1)
    } finally {
      app.stop()
    }
  })
})
