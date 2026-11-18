/**
 * test/retry.test.ts — Tests de withDbRetry y retryingClient.
 *
 * Tests unitarios (sin BD real, con cliente falso y sleep inyectado) y
 * un test de integración contra la BD de test (5442).
 */
import { describe, test, expect, mock } from 'bun:test'
import { Prisma, PrismaClient } from '@prisma/client'
import {
  DbUnavailableError,
  DB_UNAVAILABLE_MSG,
  isConnectionNotExecuted,
  isConnectionDropped,
  withDbRetry,
  retryingClient,
} from '../src/db/retry.ts'

// ─── Helpers para construir errores de Prisma ─────────────────────────────────

function makeKnown(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('error simulado', {
    code,
    clientVersion: '6.0.0',
  })
}

function makeInit(): Prisma.PrismaClientInitializationError {
  return new Prisma.PrismaClientInitializationError('init simulado', '6.0.0')
}

const noopSleep = () => Promise.resolve()

// ─── Clasificadores ───────────────────────────────────────────────────────────

describe('isConnectionNotExecuted', () => {
  test('reconoce PrismaClientInitializationError', () => {
    expect(isConnectionNotExecuted(makeInit())).toBe(true)
  })
  test('reconoce P1001', () => {
    expect(isConnectionNotExecuted(makeKnown('P1001'))).toBe(true)
  })
  test('reconoce P1002', () => {
    expect(isConnectionNotExecuted(makeKnown('P1002'))).toBe(true)
  })
  test('reconoce P2024', () => {
    expect(isConnectionNotExecuted(makeKnown('P2024'))).toBe(true)
  })
  test('no reconoce P2002', () => {
    expect(isConnectionNotExecuted(makeKnown('P2002'))).toBe(false)
  })
  test('no reconoce P1017', () => {
    expect(isConnectionNotExecuted(makeKnown('P1017'))).toBe(false)
  })
  test('no reconoce Error genérico', () => {
    expect(isConnectionNotExecuted(new Error('generico'))).toBe(false)
  })
})

describe('isConnectionDropped', () => {
  test('reconoce P1017', () => {
    expect(isConnectionDropped(makeKnown('P1017'))).toBe(true)
  })
  test('no reconoce P1001', () => {
    expect(isConnectionDropped(makeKnown('P1001'))).toBe(false)
  })
  test('no reconoce InitializationError', () => {
    expect(isConnectionDropped(makeInit())).toBe(false)
  })
})

// ─── withDbRetry — scenarios de los requirements ─────────────────────────────

describe('withDbRetry — reintentos', () => {
  test('lectura con P1001→éxito = 2 intentos', async () => {
    let calls = 0
    const fn = mock(async () => {
      calls++
      if (calls === 1) throw makeKnown('P1001')
      return 'ok'
    })

    const result = await withDbRetry(fn, { idempotent: true, sleep: noopSleep })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('NotFoundError / ValidationError / ConflictError / P2002 = 1 intento (no reintenta)', async () => {
    const errors = [
      new Error('NotFound'),
      new Error('Validation'),
      new Error('Conflict'),
      makeKnown('P2002'),
    ]

    for (const err of errors) {
      let calls = 0
      const fn = mock(async () => { calls++; throw err })
      await expect(withDbRetry(fn, { idempotent: true, sleep: noopSleep })).rejects.toBe(err)
      expect(calls).toBe(1)
    }
  })

  test('4 fallos P1001 = 4 intentos y DbUnavailableError', async () => {
    let calls = 0
    const fn = mock(async () => { calls++; throw makeKnown('P1001') })

    await expect(withDbRetry(fn, { idempotent: true, sleep: noopSleep })).rejects.toBeInstanceOf(
      DbUnavailableError,
    )
    expect(calls).toBe(4)
  })

  test('lectura P1017→éxito = 2 intentos', async () => {
    let calls = 0
    const fn = mock(async () => {
      calls++
      if (calls === 1) throw makeKnown('P1017')
      return 'leido'
    })

    const result = await withDbRetry(fn, { idempotent: true, sleep: noopSleep })
    expect(result).toBe('leido')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('escritura P1017 = 1 intento (no reintenta, error original propagado)', async () => {
    const p1017 = makeKnown('P1017')
    let calls = 0
    const fn = mock(async () => { calls++; throw p1017 })

    await expect(withDbRetry(fn, { idempotent: false, sleep: noopSleep })).rejects.toBe(p1017)
    expect(calls).toBe(1)
  })

  test('escritura con PrismaClientInitializationError→éxito = 1 sola nota creada (1 efecto)', async () => {
    let calls = 0
    const fn = mock(async () => {
      calls++
      if (calls === 1) throw makeInit()
      return 'nota-creada'
    })

    const result = await withDbRetry(fn, { idempotent: false, sleep: noopSleep })
    expect(result).toBe('nota-creada')
    // 2 llamadas (1 fail + 1 éxito) pero solo 1 efecto (el write ejecutó 1 vez)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  test('mensaje DbUnavailableError sin db.ejemplo.interno ni 5432', async () => {
    const fn = mock(async () => { throw makeKnown('P1001') })
    const err = await withDbRetry(fn, { idempotent: true, sleep: noopSleep }).catch((e) => e)
    expect(err).toBeInstanceOf(DbUnavailableError)
    expect(err.message).toBe(DB_UNAVAILABLE_MSG)
    expect(err.message).not.toContain('db.ejemplo.interno')
    expect(err.message).not.toContain('5432')
  })

  test('con tiempo simulado > 8 s no se inicia el intento siguiente', async () => {
    // La función fakeClock retorna 0 la primera vez (para `start`) y 9000 la segunda (post-fallo).
    const times = [0, 9000]
    let ti = 0
    const fakeClock = () => times[ti++] ?? 9000

    let calls = 0
    const fn = mock(async () => { calls++; throw makeKnown('P1001') })

    await expect(withDbRetry(fn, { idempotent: true, sleep: noopSleep, now: fakeClock })).rejects.toBeInstanceOf(
      DbUnavailableError,
    )
    // Solo 1 intento: después del fallo, el presupuesto de 8 s ya está agotado
    expect(calls).toBe(1)
  })
})

// ─── Test de integración con la BD real ──────────────────────────────────────

describe('retryingClient — proxy con cliente falso (sabotaje b)', () => {
  test('$transaction con P1017 = 1 intento (escritura, no reintenta P1017)', async () => {
    const p1017 = makeKnown('P1017')
    const fakeTx = mock(async () => { throw p1017 })
    // Creamos un objeto mínimo que simule la interfaz de PrismaClient
    const fakeClient = {
      $transaction: fakeTx,
      $connect: () => Promise.resolve(),
      $disconnect: () => Promise.resolve(),
    }
    const wrapped = retryingClient(fakeClient as unknown as PrismaClient, { sleep: noopSleep })
    await expect((wrapped as any).$transaction(async () => {})).rejects.toBe(p1017)
    expect(fakeTx).toHaveBeenCalledTimes(1)
  })
})

// ─── Tests de delegados lectura/escritura via Proxy ──────────────────────────
// Cubren createDelegateProxy: que escrituras (create, update…) no reintenten P1017
// y que lecturas (findMany…) sí lo hagan.
// Sabotaje para demostrar el ROJO: cambiar `const idempotent = IDEMPOTENT_DELEGATE.has(prop)`
// por `const idempotent = true` en createDelegateProxy (retry.ts:138) debe fallar estos tests.

describe('retryingClient — delegados lectura/escritura (Proxy)', () => {
  test('note.create con P1017 → 1 intento, error propagado (escritura no reintenta P1017)', async () => {
    const p1017 = makeKnown('P1017')
    const fakeCreate = mock(async () => { throw p1017 })
    const fakeClient = {
      note: { create: fakeCreate },
      $connect: () => Promise.resolve(),
      $disconnect: () => Promise.resolve(),
    }
    const wrapped = retryingClient(fakeClient as unknown as PrismaClient, { sleep: noopSleep })
    await expect((wrapped as any).note.create({ data: {} })).rejects.toBe(p1017)
    expect(fakeCreate).toHaveBeenCalledTimes(1)
  })

  test('note.findMany con P1017→éxito → 2 intentos (lectura reintenta P1017)', async () => {
    let calls = 0
    const fakeFind = mock(async () => {
      calls++
      if (calls === 1) throw makeKnown('P1017')
      return []
    })
    const fakeClient = {
      note: { findMany: fakeFind },
      $connect: () => Promise.resolve(),
      $disconnect: () => Promise.resolve(),
    }
    const wrapped = retryingClient(fakeClient as unknown as PrismaClient, { sleep: noopSleep })
    const result = await (wrapped as any).note.findMany()
    expect(result).toEqual([])
    expect(fakeFind).toHaveBeenCalledTimes(2)
  })

  test('note.create con InitializationError→éxito → 2 llamadas (no ejecutada, puede reintentar)', async () => {
    let calls = 0
    const fakeCreate = mock(async () => {
      calls++
      if (calls === 1) throw makeInit()
      return { id: 1 }
    })
    const fakeClient = {
      note: { create: fakeCreate },
      $connect: () => Promise.resolve(),
      $disconnect: () => Promise.resolve(),
    }
    const wrapped = retryingClient(fakeClient as unknown as PrismaClient, { sleep: noopSleep })
    const result = await (wrapped as any).note.create({ data: {} })
    expect(result).toEqual({ id: 1 })
    expect(fakeCreate).toHaveBeenCalledTimes(2)
  })
})

describe('retryingClient — integración con BD de test (5442)', () => {
  test('$queryRaw, note.count() y $transaction devuelven los mismos valores que el cliente sin envolver', async () => {
    const raw = new PrismaClient()
    const wrapped = retryingClient(raw) as PrismaClient

    try {
      const rawQuery = await raw.$queryRaw<[{ n: bigint }]>`SELECT 1 AS n`
      const wrappedQuery = await wrapped.$queryRaw<[{ n: bigint }]>`SELECT 1 AS n`
      expect(wrappedQuery).toEqual(rawQuery)

      const rawCount = await raw.note.count()
      const wrappedCount = await wrapped.note.count()
      expect(wrappedCount).toBe(rawCount)

      const rawTx = await raw.$transaction(async (tx) => tx.note.count())
      const wrappedTx = await wrapped.$transaction(async (tx) => tx.note.count())
      expect(wrappedTx).toBe(rawTx)
    } finally {
      await raw.$disconnect()
    }
  })
})
