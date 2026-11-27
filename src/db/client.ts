import { PrismaClient } from '@prisma/client'
import { retryingClient } from './retry.ts'
import { createIdleDisconnect, parseIdleDisconnectMinutes, IdleDisconnectHandle } from './idle-disconnect.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTimer = any

export interface DbHandle {
  prisma: PrismaClient
  idleDisconnect: IdleDisconnectHandle
  closeDb: () => Promise<void>
}

/**
 * Factoría inyectable: crea retryingClient + idleDisconnect + closeDb a partir
 * de un PrismaClient raw y los parámetros del temporizador.
 * El singleton de producción usa los defaults del proceso; los tests inyectan
 * un cliente y timers falsos.
 */
export function createDb({
  raw,
  minutes,
  setTimer,
  clearTimer,
}: {
  raw: PrismaClient
  minutes: number
  setTimer?: (fn: () => void, ms: number) => AnyTimer
  clearTimer?: (t: AnyTimer) => void
}): DbHandle {
  const idle = createIdleDisconnect({
    disconnect: () => raw.$disconnect(),
    minutes,
    setTimer: setTimer ?? setTimeout,
    clearTimer: clearTimer ?? clearTimeout,
  })
  const prisma = retryingClient(raw, { onActivity: idle.touch, reconnect: () => raw.$connect() }) as PrismaClient
  const closeDb = (): Promise<void> => {
    idle.dispose()
    return raw.$disconnect()
  }
  return { prisma, idleDisconnect: idle, closeDb }
}

/** Cliente Prisma sin reintentos — para /health y $disconnect en el cierre. */
export const rawPrisma = new PrismaClient()

const _db = createDb({
  raw: rawPrisma,
  minutes: parseIdleDisconnectMinutes(process.env.DB_IDLE_DISCONNECT_MINUTES),
})

/**
 * Temporizador de inactividad: cierra el pool tras DB_IDLE_DISCONNECT_MINUTES min
 * sin actividad (0 = desactivado). Los tests lo desactivan vía bunfig.toml.
 */
export const idleDisconnect: IdleDisconnectHandle = _db.idleDisconnect

/**
 * Cliente Prisma con reintentos automáticos ante fallos transitorios de conexión.
 * Usar en todos los handlers MCP y REST (excepto /health, que debe responder rápido).
 */
export const prisma = _db.prisma

/**
 * Cierra el pool: cancela el temporizador de inactividad y desconecta Prisma.
 * Usar en el shutdown del servidor (createShutdown.disconnect).
 */
export const closeDb = _db.closeDb
