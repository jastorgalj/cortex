/**
 * src/db/retry.ts — Reintentos ante fallos transitorios de Postgres.
 *
 * Exporta:
 *  - DbUnavailableError     — error final cuando se agotan los reintentos
 *  - isConnectionNotExecuted — P1001 / P1002 / P2024 / InitializationError
 *  - isConnectionDropped    — P1017 (conexión cortada; puede haber ejecutado)
 *  - withDbRetry            — ejecuta fn con reintento y presupuesto de 8 s
 *  - retryingClient         — Proxy sobre PrismaClient que aplica withDbRetry
 */
import { Prisma, PrismaClient } from '@prisma/client'

// ─── Error público ────────────────────────────────────────────────────────────

export const DB_UNAVAILABLE_MSG =
  'Base de datos no disponible; reintentá en unos segundos'

export class DbUnavailableError extends Error {
  cause: unknown
  constructor(cause: unknown) {
    super(DB_UNAVAILABLE_MSG)
    this.name = 'DbUnavailableError'
    this.cause = cause
  }
}

// ─── Clasificadores de error ──────────────────────────────────────────────────

/**
 * Cierto si la consulta no llegó a ejecutarse (seguro reintentar cualquier op).
 * Cubre: InitializationError, P1001, P1002, P2024.
 */
export function isConnectionNotExecuted(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return ['P1001', 'P1002', 'P2024'].includes(err.code)
  }
  return false
}

/**
 * Cierto si la conexión se cortó después de enviar (puede haber ejecutado).
 * Cubre: P1017.
 */
export function isConnectionDropped(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return err.code === 'P1017'
  }
  return false
}

// ─── withDbRetry ──────────────────────────────────────────────────────────────

export interface RetryOptions {
  /** true = reintentar también P1017 (lecturas); false = solo no-ejecutados (escrituras). */
  idempotent: boolean
  /** Función de espera; inyectada en tests para no esperar de verdad. */
  sleep?: (ms: number) => Promise<void>
  /** Fuente de tiempo; inyectada en tests. */
  now?: () => number
  /** Callback de actividad; llamado una vez al empezar y una vez al terminar (finally). */
  onActivity?: () => void
}

/** Esperas entre intentos: 200 / 500 / 1000 ms. */
const DELAYS = [200, 500, 1000] as const

/**
 * Ejecuta fn con reintentos.
 * - Reintenta errores de conexión no ejecutados (siempre) y P1017 (si idempotent).
 * - Presupuesto total: 8 s desde el primer intento.
 * - Tras 3 reintentos (4 intentos en total) o presupuesto agotado: DbUnavailableError.
 * - Errores no de conexión se propagan sin modificar.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  { idempotent, sleep = defaultSleep, now = Date.now, onActivity }: RetryOptions,
): Promise<T> {
  onActivity?.()
  try {
    const start = now()
    let attempt = 0

    while (true) {
      try {
        return await fn()
      } catch (err) {
        const notExecuted = isConnectionNotExecuted(err)
        const dropped = idempotent && isConnectionDropped(err)
        const retryable = notExecuted || dropped

        if (!retryable) throw err

        // Verificar presupuesto ANTES de dormir
        if (attempt >= DELAYS.length || now() - start >= 8000) {
          console.error('[cortex] withDbRetry: agotados los reintentos:', err)
          throw new DbUnavailableError(err)
        }

        await sleep(DELAYS[attempt]!)
        attempt++
      }
    }
  } finally {
    onActivity?.()
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── retryingClient ───────────────────────────────────────────────────────────

/** Métodos del cliente Prisma que NO se envuelven. */
const SKIP_METHODS = new Set(['$connect', '$disconnect', '$on', '$extends', '$use'])

/** Métodos de alto nivel cuya naturaleza es de lectura (idempotent: true). */
const IDEMPOTENT_TOP = new Set(['$queryRaw', '$queryRawUnsafe'])

/** Métodos de alto nivel cuya naturaleza es de escritura (idempotent: false). */
const WRITE_TOP = new Set(['$executeRaw', '$executeRawUnsafe', '$transaction'])

/** Métodos de delegado de modelo que son lecturas (idempotent: true). */
const IDEMPOTENT_DELEGATE = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
])

function createDelegateProxy(
  delegate: object,
  options: Pick<RetryOptions, 'sleep' | 'now' | 'onActivity'>,
): object {
  return new Proxy(delegate, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop)
      const val = Reflect.get(target, prop)
      if (typeof val !== 'function') return val
      const idempotent = IDEMPOTENT_DELEGATE.has(prop)
      return (...args: unknown[]) =>
        withDbRetry(
          () => (val as (...a: unknown[]) => Promise<unknown>).apply(target, args),
          { idempotent, ...options },
        )
    },
  })
}

/**
 * Envuelve un PrismaClient con un Proxy que aplica withDbRetry a todas las llamadas.
 * Usar `rawPrisma.$disconnect()` para desconectar (no envuelto).
 */
export function retryingClient(
  client: PrismaClient,
  options: Pick<RetryOptions, 'sleep' | 'now' | 'onActivity'> = {},
): PrismaClient {
  // Caché de proxies de delegados para mantener identidad de referencia
  const delegateCache = new Map<string, object>()

  return new Proxy(client, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop)

      // Métodos que no se envuelven
      if (SKIP_METHODS.has(prop)) return Reflect.get(target, prop)

      const val = Reflect.get(target, prop)

      // Lecturas de alto nivel
      if (IDEMPOTENT_TOP.has(prop)) {
        if (typeof val !== 'function') return val
        return (...args: unknown[]) =>
          withDbRetry(
            () => (val as (...a: unknown[]) => Promise<unknown>).apply(target, args),
            { idempotent: true, ...options },
          )
      }

      // Escrituras de alto nivel
      if (WRITE_TOP.has(prop)) {
        if (typeof val !== 'function') return val
        return (...args: unknown[]) =>
          withDbRetry(
            () => (val as (...a: unknown[]) => Promise<unknown>).apply(target, args),
            { idempotent: false, ...options },
          )
      }

      // Delegado de modelo (objeto, no función, no null, no array)
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        if (!delegateCache.has(prop)) {
          delegateCache.set(prop, createDelegateProxy(val as object, options))
        }
        return delegateCache.get(prop)
      }

      return val
    },
  }) as PrismaClient
}
