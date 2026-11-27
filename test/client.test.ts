/**
 * test/client.test.ts — Tests de closeDb (G1) + cableado onActivity (G2a)
 * + isPoolIdle default de createApp (G2b).
 *
 * G1: closeDb() cancela el timer de inactividad e invoca $disconnect 1 vez.
 * G2a: una query vía prisma (retryingClient) llama touch() y reprograma el timer.
 * G2b: createApp() sin isPoolIdle usa idleDisconnect.isIdle() del singleton.
 */
import { describe, test, expect, spyOn } from 'bun:test'
import { Prisma, PrismaClient } from '@prisma/client'
import { createDb, idleDisconnect } from '../src/db/client.ts'
import { createApp } from '../src/index.ts'

// ─── Fake timer helper ────────────────────────────────────────────────────────

interface FakeHandle {
  _unrefed: boolean
  unref(): void
}

interface FakeEntry {
  handle: FakeHandle
  cb: () => void | Promise<void>
  ms: number
}

function makeFakeTimers() {
  const entries: FakeEntry[] = []
  const setTimer = (cb: () => void, ms: number): FakeHandle => {
    const handle: FakeHandle = { _unrefed: false, unref() { this._unrefed = true } }
    entries.push({ handle, cb, ms })
    return handle
  }
  const clearTimer = (t: FakeHandle) => {
    const idx = entries.findIndex((e) => e.handle === t)
    if (idx >= 0) entries.splice(idx, 1)
  }
  return { setTimer, clearTimer, entries }
}

// ─── G1 — closeDb() cancela el timer e invoca $disconnect ─────────────────────

describe('createDb — closeDb() cancela el timer e invoca $disconnect', () => {
  test('closeDb() cancela el timer activo y llama $disconnect 1 vez', async () => {
    const { setTimer, clearTimer, entries } = makeFakeTimers()
    let disconnectCalls = 0
    const fakeRaw = {
      $disconnect: () => { disconnectCalls++; return Promise.resolve() },
    } as unknown as PrismaClient

    const { closeDb: close, idleDisconnect: idle } = createDb({
      raw: fakeRaw,
      minutes: 4,
      setTimer,
      clearTimer,
    })

    expect(entries.length).toBe(1) // timer inicial armado

    await close()

    expect(disconnectCalls).toBe(1)
    expect(entries.length).toBe(0) // dispose() lo canceló

    // touch() tras dispose no reprograma
    idle.touch()
    expect(entries.length).toBe(0)
  })
})

// ─── G2a — prisma usa onActivity: idleDisconnect.touch ───────────────────────

describe('createDb — prisma usa onActivity: idleDisconnect.touch', () => {
  test('una query vía prisma reprograma el timer (handle distinto, ms === 240_000)', async () => {
    const { setTimer, clearTimer, entries } = makeFakeTimers()
    const fakeRaw = {
      $disconnect: () => Promise.resolve(),
      note: { count: (_args?: unknown) => Promise.resolve(42) },
    } as unknown as PrismaClient

    const { prisma: p } = createDb({ raw: fakeRaw, minutes: 4, setTimer, clearTimer })

    expect(entries.length).toBe(1)
    const handleBefore = entries[0]!.handle

    // Query vía retryingClient → onActivity (touch) llamado en inicio y en finally
    await p.note.count({ where: { deleted_at: null } })

    // touch() limpió el timer viejo y armó uno nuevo
    expect(entries.length).toBe(1)
    expect(entries[0]!.handle).not.toBe(handleBefore) // reprogramado por touch
    expect(entries[0]!.ms).toBe(240_000)
  })
})

// ─── G2b — createApp default isPoolIdle usa idleDisconnect.isIdle() ──────────

const G2B_PORT = 13196
const G2B_URL = `http://localhost:${G2B_PORT}`

describe('createApp — isPoolIdle default usa idleDisconnect.isIdle()', () => {
  test(
    'sin isPoolIdle: spy isIdle=true → /health db_pool:idle',
    async () => {
      const isIdleSpy = spyOn(idleDisconnect, 'isIdle').mockReturnValue(true)

      const app = createApp() // sin isPoolIdle → usa default
      app.listen(G2B_PORT)
      try {
        const r = await fetch(`${G2B_URL}/health`)
        expect(r.status).toBe(200)
        const body = (await r.json()) as Record<string, unknown>
        expect(body.db_pool).toBe('idle')
        // El health nunca devuelve notes (no sondea la BD)
        expect(body.notes).toBeUndefined()
      } finally {
        app.stop()
        isIdleSpy.mockRestore()
      }
    },
  )
})

// ─── G3 — reconnect cableado en createDb → retryingClient ────────────────────
//
// Verifica que `createDb` pasa `reconnect: () => raw.$connect()` al
// retryingClient. Si se elimina esa línea de client.ts, raw.$connect no se
// llama y la aserción connectCalls===1 falla (ROJO demostrado).

describe('createDb — reconnect cableado en retryingClient', () => {
  test('P1001 en primer intento → raw.$connect llamado 1 vez, query exitosa al reintentar', async () => {
    const { setTimer, clearTimer } = makeFakeTimers()
    let connectCalls = 0
    let countCalls = 0

    const fakeRaw = {
      $disconnect: () => Promise.resolve(),
      $connect: () => { connectCalls++; return Promise.resolve() },
      note: {
        count: (_args?: unknown) => {
          countCalls++
          if (countCalls === 1) {
            return Promise.reject(
              new Prisma.PrismaClientKnownRequestError('error simulado P1001', {
                code: 'P1001',
                clientVersion: '6.0.0',
              }),
            )
          }
          return Promise.resolve(42)
        },
      },
    } as unknown as PrismaClient

    const { prisma: p } = createDb({ raw: fakeRaw, minutes: 4, setTimer, clearTimer })

    const result = await p.note.count({ where: { deleted_at: null } })

    expect(result).toBe(42)        // la query fue reintentada con éxito
    expect(connectCalls).toBe(1)  // reconnect llamado exactamente 1 vez (primer reintento)
    expect(countCalls).toBe(2)    // 1 fallo P1001 + 1 éxito
  })
})
