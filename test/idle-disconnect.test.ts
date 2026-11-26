/**
 * test/idle-disconnect.test.ts — Tests de idle-disconnect (grupo 1).
 *
 * Tests unitarios (sin BD, temporizadores falsos inyectados) y un test de
 * integración contra la BD de test (:5460).
 */
import { describe, test, expect, mock, spyOn } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import {
  createIdleDisconnect,
  parseIdleDisconnectMinutes,
  DEFAULT_IDLE_DISCONNECT_MINUTES,
} from '../src/db/idle-disconnect.ts'
import { retryingClient } from '../src/db/retry.ts'

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

  // Ejecuta el primer temporizador pendiente
  const tick = async (): Promise<void> => {
    const entry = entries.shift()
    if (entry) await entry.cb()
  }

  return { setTimer, clearTimer, tick, entries }
}

// ─── Escenarios unitarios (task 1.3) ─────────────────────────────────────────

describe('createIdleDisconnect — 4 min sin actividad → disconnect 1 vez', () => {
  test('timer inicial vence → disconnect llamado 1 vez e isIdle() true', async () => {
    const disconnect = mock(() => Promise.resolve())
    const { setTimer, clearTimer, tick } = makeFakeTimers()

    const idle = createIdleDisconnect({ disconnect, minutes: 4, setTimer, clearTimer })
    expect(idle.isIdle()).toBe(false)

    await tick()

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(idle.isIdle()).toBe(true)
  })
})

describe('createIdleDisconnect — sin ninguna operación desde la creación → disconnect 1 vez', () => {
  test('sin ningún touch → disconnect llamado exactamente 1 vez', async () => {
    const disconnect = mock(() => Promise.resolve())
    const { setTimer, clearTimer, tick, entries } = makeFakeTimers()

    const idle = createIdleDisconnect({ disconnect, minutes: 4, setTimer, clearTimer })
    expect(entries[0]!.ms).toBe(240_000) // 4 min * 60_000 ms/min

    // No llamamos touch() en ningún momento
    await tick() // dispara el timer inicial

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(idle.isIdle()).toBe(true)
  })
})

describe('createIdleDisconnect — touch() a los 3 min → no desconecta a los 4, sí a los 7', () => {
  test('touch() cancela el timer viejo y el nuevo timer luego desconecta', async () => {
    const disconnect = mock(() => Promise.resolve())
    const { setTimer, clearTimer, tick, entries } = makeFakeTimers()

    const idle = createIdleDisconnect({ disconnect, minutes: 4, setTimer, clearTimer })
    expect(entries.length).toBe(1) // timer inicial
    expect(entries[0]!.ms).toBe(240_000) // 4 min * 60_000 ms/min

    idle.touch() // cancela el inicial, crea uno nuevo
    expect(entries.length).toBe(1) // solo el nuevo timer
    expect(entries[0]!.ms).toBe(240_000) // nuevo timer también plazo completo

    // "Tick a los 4 min" ya no existe (fue cancelado); tick dispara el único pendiente
    await tick() // = tick a los 7 min (4 min después del touch)

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(idle.isIdle()).toBe(true)
  })
})

describe('createIdleDisconnect — operación 0→3 min (dos touch()) → nada a los 6, desconexión a los 7', () => {
  test('dos touch() consecutivos → solo el último timer queda y desconecta al vencer', async () => {
    const disconnect = mock(() => Promise.resolve())
    const { setTimer, clearTimer, tick, entries } = makeFakeTimers()

    const idle = createIdleDisconnect({ disconnect, minutes: 4, setTimer, clearTimer })
    expect(entries.length).toBe(1)

    idle.touch() // min 0: inicia operación; cancela inicial, crea timer B
    expect(entries.length).toBe(1)

    idle.touch() // min 3: termina operación; cancela B, crea timer C
    expect(entries.length).toBe(1) // solo C

    // "Al minuto 6" solo existiría B, pero B ya fue cancelado; solo C está pendiente
    // Tick dispara C (= minuto 3+4=7)
    await tick()

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(idle.isIdle()).toBe(true)
  })
})

describe('createIdleDisconnect — disconnect que rechaza', () => {
  test('log llamado, isIdle() false, plazo reprogramado', async () => {
    const err = new Error('fallo de bd')
    const disconnect = mock(() => Promise.reject(err))
    const log = mock((_e: unknown) => {})
    const { setTimer, clearTimer, tick, entries } = makeFakeTimers()

    const idle = createIdleDisconnect({ disconnect, minutes: 4, setTimer, clearTimer, log })
    expect(entries.length).toBe(1)
    expect(entries[0]!.ms).toBe(240_000) // plazo inicial

    await tick() // dispara el timer → disconnect rechaza → schedule() de nuevo

    expect(log).toHaveBeenCalledWith(err)
    expect(idle.isIdle()).toBe(false)
    expect(entries.length).toBe(1) // reprogramado
    expect(entries[0]!.ms).toBe(240_000) // plazo completo al reprogramar
  })
})

describe('createIdleDisconnect — touch() durante disconnect pendiente', () => {
  test('al resolver disconnect, isIdle() es false (generación cambió)', async () => {
    let resolveDisconnect!: () => void
    const disconnect = mock(() => new Promise<void>((r) => { resolveDisconnect = r }))
    const { setTimer, clearTimer, tick } = makeFakeTimers()

    const idle = createIdleDisconnect({ disconnect, minutes: 4, setTimer, clearTimer })

    // Disparar el timer: onTimer inicia, await disconnect() suspende
    const tickPromise = tick()

    // touch() durante el disconnect pendiente
    idle.touch()

    // Ahora resolver el disconnect
    resolveDisconnect()
    await tickPromise

    expect(idle.isIdle()).toBe(false)
  })
})

describe('createIdleDisconnect — minutes: 0', () => {
  test('0 temporizadores creados e isIdle() false siempre', async () => {
    const disconnect = mock(() => Promise.resolve())
    const setTimerSpy = mock((_cb: () => void, _ms: number) => ({ unref: () => {} }))
    const clearTimer = mock((_t: unknown) => {})

    const idle = createIdleDisconnect({
      disconnect,
      minutes: 0,
      setTimer: setTimerSpy,
      clearTimer,
    })

    // Avanzar "60 min" → no hay timers que disparar
    expect(setTimerSpy).toHaveBeenCalledTimes(0)
    expect(idle.isIdle()).toBe(false)

    idle.touch() // debe ser no-op
    expect(setTimerSpy).toHaveBeenCalledTimes(0)
    expect(idle.isIdle()).toBe(false)
  })
})

describe('createIdleDisconnect — dispose()', () => {
  test('cancela el timer y touch() posterior no crea otro', () => {
    const disconnect = mock(() => Promise.resolve())
    const { setTimer, clearTimer, entries } = makeFakeTimers()

    const idle = createIdleDisconnect({ disconnect, minutes: 4, setTimer, clearTimer })
    expect(entries.length).toBe(1)

    idle.dispose()
    expect(entries.length).toBe(0) // timer cancelado

    idle.touch() // debe ser no-op
    expect(entries.length).toBe(0) // no creó otro
  })
})

describe('createIdleDisconnect — unref()', () => {
  test('el handle del temporizador recibió unref()', () => {
    const disconnect = mock(() => Promise.resolve())
    const handles: { _unrefed: boolean; unref(): void }[] = []
    const setTimer = (cb: () => void, ms: number) => {
      const h = { _unrefed: false, unref() { this._unrefed = true } }
      handles.push(h)
      return h
    }
    const clearTimer = (_t: unknown) => {}

    createIdleDisconnect({ disconnect, minutes: 4, setTimer, clearTimer })

    expect(handles.length).toBeGreaterThanOrEqual(1)
    expect(handles[0]!._unrefed).toBe(true)
  })
})

// ─── parseIdleDisconnectMinutes (task 1.3) ───────────────────────────────────

describe('parseIdleDisconnectMinutes', () => {
  test('undefined → DEFAULT sin warn', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseIdleDisconnectMinutes(undefined)).toBe(DEFAULT_IDLE_DISCONNECT_MINUTES)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  test("'' → DEFAULT sin warn", () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseIdleDisconnectMinutes('')).toBe(DEFAULT_IDLE_DISCONNECT_MINUTES)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  test("'  ' (solo espacios) → DEFAULT sin warn", () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseIdleDisconnectMinutes('  ')).toBe(DEFAULT_IDLE_DISCONNECT_MINUTES)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  test("'0' → 0", () => {
    expect(parseIdleDisconnectMinutes('0')).toBe(0)
  })

  test("'abc' → DEFAULT y warn con nombre de variable y valor", () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseIdleDisconnectMinutes('abc')).toBe(DEFAULT_IDLE_DISCONNECT_MINUTES)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = (warnSpy.mock.calls[0]![0] as string)
    expect(msg).toContain('DB_IDLE_DISCONNECT_MINUTES')
    expect(msg).toContain('abc')
    warnSpy.mockRestore()
  })

  test("'-3' → DEFAULT y warn con nombre de variable y valor", () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseIdleDisconnectMinutes('-3')).toBe(DEFAULT_IDLE_DISCONNECT_MINUTES)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const msg = (warnSpy.mock.calls[0]![0] as string)
    expect(msg).toContain('DB_IDLE_DISCONNECT_MINUTES')
    expect(msg).toContain('-3')
    warnSpy.mockRestore()
  })

  test("'7' → 7", () => {
    expect(parseIdleDisconnectMinutes('7')).toBe(7)
  })

  test("'0.5' → 0.5", () => {
    expect(parseIdleDisconnectMinutes('0.5')).toBe(0.5)
  })
})

// ─── Test de integración con BD real (task 1.4) ───────────────────────────────

describe('createIdleDisconnect — integración con BD real (:5460, plazo ~120 ms)', () => {
  test('note.count OK → idle → reconexión → isIdle() false', async () => {
    const raw = new PrismaClient()
    const idle = createIdleDisconnect({
      disconnect: () => raw.$disconnect(),
      minutes: 0.002, // ≈ 120 ms
    })
    const prisma = retryingClient(raw, { onActivity: idle.touch }) as PrismaClient

    try {
      // Consulta inicial → activa el pool y resetea el timer
      await prisma.note.count()
      expect(idle.isIdle()).toBe(false)

      // Esperar más que el plazo (400 ms > 120 ms) → idle
      await new Promise((r) => setTimeout(r, 400))
      expect(idle.isIdle()).toBe(true)

      // Consulta tras idle → reconexión perezosa de Prisma
      await prisma.note.count()
      expect(idle.isIdle()).toBe(false)
    } finally {
      idle.dispose()
      await raw.$disconnect()
    }
  }, 10_000)
})
