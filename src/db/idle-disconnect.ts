/**
 * src/db/idle-disconnect.ts — Desconexión del pool por inactividad.
 *
 * Exporta:
 *  - DEFAULT_IDLE_DISCONNECT_MINUTES — defecto (4)
 *  - parseIdleDisconnectMinutes      — lee y valida DB_IDLE_DISCONNECT_MINUTES
 *  - createIdleDisconnect            — temporizador de inactividad con generación
 */

export const DEFAULT_IDLE_DISCONNECT_MINUTES = 4

/**
 * Lee el valor de DB_IDLE_DISCONNECT_MINUTES.
 * - undefined o cadena vacía/solo espacios → 4 sin aviso.
 * - 0 → 0 (desactivado; sin temporizador).
 * - Número negativo o no finito → 4 con console.warn.
 * - Decimales permitidos (0.5 → 0.5).
 */
export function parseIdleDisconnectMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_IDLE_DISCONNECT_MINUTES
  const n = Number(raw)
  if (!isFinite(n) || n < 0) {
    console.warn(
      `[cortex] DB_IDLE_DISCONNECT_MINUTES valor inválido: "${raw}"; usando ${DEFAULT_IDLE_DISCONNECT_MINUTES}`,
    )
    return DEFAULT_IDLE_DISCONNECT_MINUTES
  }
  return n
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTimer = any

export interface IdleDisconnectHandle {
  touch(): void
  isIdle(): boolean
  dispose(): void
}

/**
 * Crea un temporizador de inactividad que llama a `disconnect` tras `minutes` minutos
 * sin ninguna llamada a `touch()`.
 *
 * - `setTimer` y `clearTimer`: inyectables para tests (por defecto setTimeout/clearTimeout).
 * - El temporizador creado recibe `unref()` si lo tiene (para que no retenga el proceso).
 * - `minutes === 0`: sin temporizador; `isIdle()` siempre `false`.
 * - `dispose()`: cancela el temporizador y deja `touch()` sin efecto.
 * - El temporizador se arma al crear la instancia (plazo contado desde el arranque).
 */
export function createIdleDisconnect({
  disconnect,
  minutes,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = console.error,
}: {
  disconnect: () => Promise<void>
  minutes: number
  setTimer?: (fn: () => void, ms: number) => AnyTimer
  clearTimer?: (t: AnyTimer) => void
  log?: (err: unknown) => void
}): IdleDisconnectHandle {
  let idle = false
  let generation = 0
  let timer: AnyTimer = null
  let disposed = false

  function schedule(): void {
    if (disposed || minutes === 0) return
    const ms = minutes * 60_000
    timer = setTimer(onTimer, ms)
    if (timer != null && typeof timer.unref === 'function') timer.unref()
  }

  async function onTimer(): Promise<void> {
    timer = null
    const gen = generation
    try {
      await disconnect()
      // Solo marcar idle si la generación no cambió durante el disconnect
      if (generation === gen) {
        idle = true
      }
    } catch (err) {
      log(err)
      // No marcar idle; reprogramar el plazo completo
      schedule()
    }
  }

  function touch(): void {
    if (disposed || minutes === 0) return
    idle = false
    generation++
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    schedule()
  }

  function isIdle(): boolean {
    return idle
  }

  function dispose(): void {
    disposed = true
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  // Arrancar con temporizador armado (plazo contado desde el arranque)
  schedule()

  return { touch, isIdle, dispose }
}
