/**
 * test/shutdown.test.ts — Tests de cierre limpio (grupo 4).
 *
 * 4.3: stubs con exit espiado — orden, timeout, segunda llamada, disconnect que rechaza.
 * 4.4: integración con la app real (puerto 13193) — request lenta en curso termina 200
 *      después de llamar al handler; fetch nuevo posterior es rechazado.
 *      Verifica la hipótesis D4 de que app.stop() sin true deja terminar requests en curso.
 */
import { describe, test, expect, mock } from 'bun:test'
import { createShutdown } from '../src/shutdown.ts'
import { createApp } from '../src/index.ts'

// ─── 4.3 — Tests unitarios con stubs ────────────────────────────────────────

describe('createShutdown — orden y códigos de salida', () => {
  test('orden log → closeSessions → stopServer → disconnect → exit(0)', async () => {
    const order: string[] = []
    const exit = mock((_code: number) => {})
    const shutdown = createShutdown({
      closeSessions: () => { order.push('closeSessions') },
      stopServer: async () => { order.push('stopServer') },
      disconnect: async () => { order.push('disconnect') },
      log: () => { order.push('log') },
      exit,
    })

    await shutdown('SIGTERM')

    // Orden relativo verificado; not.toBe(-1) garantiza que closeSessions está en el array
    // (indexOf=-1 < cualquier índice positivo pasaba antes aunque closeSessions faltara)
    expect(order.indexOf('closeSessions')).not.toBe(-1)
    expect(order.indexOf('closeSessions')).toBeLessThan(order.indexOf('stopServer'))
    expect(order.indexOf('stopServer')).toBeLessThan(order.indexOf('disconnect'))
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  test('stopServer que no termina en 8 s → exit(1) y disconnect igualmente intentado', async () => {
    const exit = mock((_code: number) => {})
    const disconnect = mock(async () => {})
    const shutdown = createShutdown({
      closeSessions: () => {},
      stopServer: () => new Promise<void>(() => {}), // nunca resuelve
      disconnect,
      log: () => {},
      exit,
      graceMs: 50, // tope corto para el test (el diseño usa 8000 por defecto)
    })

    await shutdown('SIGTERM')

    expect(exit).toHaveBeenCalledWith(1)
    // disconnect se intentó igualmente
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  test('segunda llamada → exit(1) inmediato sin repetir pasos', async () => {
    const closeSessions = mock(() => {})
    const stopServer = mock(async () => {})
    const disconnect = mock(async () => {})
    const exit = mock((_code: number) => {})
    const shutdown = createShutdown({
      closeSessions,
      stopServer,
      disconnect,
      log: () => {},
      exit,
    })

    // Primera llamada completa
    await shutdown('SIGTERM')
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenLastCalledWith(0)

    // Segunda llamada: exit(1) sin repetir pasos
    await shutdown('SIGTERM')
    expect(exit).toHaveBeenCalledTimes(2)
    expect(exit).toHaveBeenLastCalledWith(1)
    expect(closeSessions).toHaveBeenCalledTimes(1)
    expect(stopServer).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  test('disconnect que rechaza → exit(1) y log del error', async () => {
    const logs: string[] = []
    const exit = mock((_code: number) => {})
    const shutdown = createShutdown({
      closeSessions: () => {},
      stopServer: async () => {},
      disconnect: async () => { throw new Error('fallo de desconexión') },
      log: (msg: string) => { logs.push(msg) },
      exit,
    })

    await shutdown('SIGTERM')

    expect(exit).toHaveBeenCalledWith(1)
    expect(logs.some((l) => l.includes('fallo de desconexión'))).toBe(true)
  })
})

// ─── 4.4 — Integración con la app real ──────────────────────────────────────

const SHUTDOWN_PORT = 13193
const SHUTDOWN_URL = `http://localhost:${SHUTDOWN_PORT}`

describe('createShutdown — integración con la app real (D4)', () => {
  test('una request lenta en curso termina 200 tras el cierre; fetch nuevo es rechazado', async () => {
    let releaseSlow: (() => void) | null = null

    const app = createApp()
    // Ruta lenta inyectada: simula una operación que tarda en responder
    app.get('/test-slow', async () => {
      await new Promise<void>((resolve) => { releaseSlow = resolve })
      return { status: 'ok' }
    })
    app.listen(SHUTDOWN_PORT)

    const exit = mock((_code: number) => {})
    const shutdown = createShutdown({
      closeSessions: () => {},
      stopServer: async () => { await app.stop() },
      disconnect: async () => {},
      log: () => {},
      exit,
      graceMs: 8000,
    })

    // Lanza la request lenta (queda pendiente en la ruta /test-slow)
    const slowPromise = fetch(`${SHUTDOWN_URL}/test-slow`)

    // Espera un instante para que la request llegue al handler
    await new Promise((r) => setTimeout(r, 100))
    expect(releaseSlow).not.toBeNull()

    // Inicia el cierre (no espera a que termine: lo disparamos sin await todavía)
    const shutdownPromise = shutdown('SIGTERM')

    // Libera la request lenta: app.stop() sin true debe dejarla terminar
    await new Promise((r) => setTimeout(r, 100))
    releaseSlow!()

    // La request lenta debe terminar con 200 (hipótesis D4 verificada)
    const slowResponse = await slowPromise
    expect(slowResponse.status).toBe(200)
    const body = (await slowResponse.json()) as { status: string }
    expect(body.status).toBe('ok')

    await shutdownPromise

    // Un fetch nuevo posterior es rechazado (el servidor ya no escucha)
    let failed = false
    try {
      await fetch(`${SHUTDOWN_URL}/test-slow`)
    } catch {
      failed = true
    }
    expect(failed).toBe(true)
  })
})
