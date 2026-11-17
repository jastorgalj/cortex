/**
 * test/sessions.test.ts — Tests unitarios de SessionRegistry y parseSessionTtlMinutes.
 *
 * Transports falsos con close() espiado y reloj inyectado.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test'
import { SessionRegistry, parseSessionTtlMinutes } from '../src/tools/sessions.ts'

function fakeTransport(): { handleRequest: (r: Request) => Promise<Response>; close: ReturnType<typeof mock> } {
  return {
    handleRequest: async () => new Response(null),
    close: mock(() => {}),
  }
}

// ─── TTL / expiración ────────────────────────────────────────────────────────

describe('SessionRegistry — expiración por TTL', () => {
  test('TTL+1 ms se elimina y close() es llamado', () => {
    let now = 1_000_000
    const clock = () => now
    const registry = new SessionRegistry(clock)
    const t = fakeTransport()
    registry.add('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', t)

    const ttlMs = 1000
    now += ttlMs + 1
    registry.sweep(now, ttlMs)

    expect(registry.size).toBe(0)
    expect(t.close).toHaveBeenCalledTimes(1)
  })

  test('TTL−1 min permanece', () => {
    let now = 1_000_000
    const clock = () => now
    const registry = new SessionRegistry(clock)
    const t = fakeTransport()
    registry.add('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', t)

    const ttlMs = 120_000 // 2 min
    now += 60_000 // inactividad 1 min = TTL−1 min → dentro del TTL
    registry.sweep(now, ttlMs)

    expect(registry.size).toBe(1)
    expect(t.close).toHaveBeenCalledTimes(0)
  })

  test('una request con el id renueva el TTL', () => {
    let now = 1_000_000
    const clock = () => now
    const registry = new SessionRegistry(clock)
    const t = fakeTransport()
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    registry.add(id, t)

    const ttlMs = 60_000
    now += 50_000
    // La actividad renueva lastSeen
    const got = registry.get(id)
    expect(got).toBe(t)
    // Avanza otros 50 s desde la renovación → total 100 s desde el alta, pero 50 s desde la renovación
    now += 50_000
    registry.sweep(now, ttlMs)

    expect(registry.size).toBe(1)
    expect(t.close).toHaveBeenCalledTimes(0)
  })
})

// ─── get devuelve undefined para id desconocido ──────────────────────────────

describe('SessionRegistry — get', () => {
  test('id desconocido devuelve undefined', () => {
    const registry = new SessionRegistry(() => 0)
    expect(registry.get('no-existe')).toBeUndefined()
  })
})

// ─── Log de alta y baja ──────────────────────────────────────────────────────

describe('SessionRegistry — log de alta y baja', () => {
  const originalLog = console.log
  let logged: string[]

  beforeEach(() => {
    logged = []
    console.log = (msg: unknown) => { logged.push(String(msg)) }
  })
  afterEach(() => {
    console.log = originalLog
  })

  test('alta escribe "sesión creada <id8>" y baja escribe "sesión cerrada <id8> motivo=delete"', () => {
    const registry = new SessionRegistry(() => 1000)
    const t = fakeTransport()
    const id = 'abcdefgh-1234-5678-9abc-def012345678'
    registry.add(id, t)

    expect(logged.some((l) => l.includes('sesión creada abcdefgh'))).toBe(true)
    expect(logged.some((l) => l.includes('(activas: 1)'))).toBe(true)

    registry.delete(id, 'delete')
    expect(logged.some((l) => l.includes('sesión cerrada abcdefgh motivo=delete'))).toBe(true)
    expect(t.close).toHaveBeenCalledTimes(1)
  })
})

// ─── parseSessionTtlMinutes ──────────────────────────────────────────────────

describe('parseSessionTtlMinutes', () => {
  test('undefined → 1440', () => {
    expect(parseSessionTtlMinutes(undefined)).toBe(1440)
  })

  test('"abc" → 1440 y avisa', () => {
    const originalWarn = console.warn
    const warned: string[] = []
    console.warn = (msg: unknown) => { warned.push(String(msg)) }
    try {
      expect(parseSessionTtlMinutes('abc')).toBe(1440)
      expect(warned.some((w) => w.includes('abc'))).toBe(true)
    } finally {
      console.warn = originalWarn
    }
  })

  test('"0" → 1440', () => {
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      expect(parseSessionTtlMinutes('0')).toBe(1440)
    } finally {
      console.warn = originalWarn
    }
  })

  test('"-5" → 1440', () => {
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      expect(parseSessionTtlMinutes('-5')).toBe(1440)
    } finally {
      console.warn = originalWarn
    }
  })

  test('"60" → 60', () => {
    expect(parseSessionTtlMinutes('60')).toBe(60)
  })
})
