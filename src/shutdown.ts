/**
 * src/shutdown.ts — Cierre limpio del servidor (design D4).
 *
 * Orden: log → closeSessions('shutdown') → stopServer() con tope graceMs →
 * disconnect() → exit(0). Si stopServer excede graceMs: log + exit(1) tras intentar disconnect.
 * Segunda llamada: exit(1) inmediato sin repetir pasos.
 */

export interface ShutdownOptions {
  /** Cierra las sesiones MCP activas (incluye streams SSE). */
  closeSessions: (motivo: 'shutdown') => void
  /** Detiene el servidor HTTP sin cortar requests en curso. */
  stopServer: () => Promise<void>
  /** Desconecta el cliente Prisma. */
  disconnect: () => Promise<void>
  /** Log de cierre (default: console.log). */
  log?: (msg: string) => void
  /** Salida del proceso (default: process.exit). */
  exit?: (code: number) => void
  /** Tope de espera para stopServer en ms (default: 8000). */
  graceMs?: number
}

export type ShutdownHandler = (motivo: string, forceExitCode?: number) => Promise<void>

export function createShutdown({
  closeSessions,
  stopServer,
  disconnect,
  log = (msg: string) => console.log(msg),
  exit = (code: number) => process.exit(code),
  graceMs = 8000,
}: ShutdownOptions): ShutdownHandler {
  let shuttingDown = false

  return async function shutdown(motivo: string, forceExitCode?: number): Promise<void> {
    if (shuttingDown) {
      // Segunda señal: salir inmediatamente con código 1
      log(`[cortex] cierre ya en curso; forzando salida (motivo=${motivo})`)
      exit(1)
      return
    }
    shuttingDown = true

    let finalCode = forceExitCode ?? 0

    log(`[cortex] cerrando servidor (motivo=${motivo})...`)

    // 1. Cerrar sesiones MCP (incluye streams SSE)
    try {
      closeSessions('shutdown')
      log('[cortex] sesiones MCP cerradas')
    } catch (err) {
      log(`[cortex] error al cerrar sesiones: ${err instanceof Error ? err.message : String(err)}`)
      finalCode = 1
    }

    // 2. Detener el servidor con tope de graceMs
    const timedOut = await stopWithTimeout(stopServer, graceMs)
    if (timedOut) {
      log(`[cortex] stopServer excedió ${graceMs} ms; continuando el cierre`)
      finalCode = 1
    }

    // 3. Desconectar Prisma (siempre se intenta)
    try {
      await disconnect()
      log('[cortex] Prisma desconectado')
    } catch (err) {
      log(`[cortex] error al desconectar Prisma: ${err instanceof Error ? err.message : String(err)}`)
      finalCode = 1
    }

    log(`[cortex] servidor cerrado (código ${finalCode})`)
    exit(finalCode)
  }
}

/**
 * Ejecuta stopServer con un tope de tiempo.
 * Devuelve true si se agotó el tiempo, false si terminó normalmente.
 */
async function stopWithTimeout(stopServer: () => Promise<void>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), graceMs)
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      ;(timer as unknown as { unref: () => void }).unref()
    }
  })
  const done = stopServer()
    .then(() => false as const)
    .catch((err) => {
      console.error('[cortex] stopServer falló:', err)
      return false as const
    })
  try {
    return await Promise.race([done, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
