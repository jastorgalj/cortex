/**
 * src/health.ts — Sonda de salud con timeout propio y sondeo único compartido.
 *
 * createHealthProbe({ countNotes, timeoutMs?, staleMs?, now? })
 *   Devuelve un probe() que:
 *   - Usa Promise.race con timeout de 3 s.
 *   - Comparte el sondeo en curso entre requests concurrentes.
 *   - Descarta el sondeo si lleva > staleMs ms (default 30 s) y crea uno nuevo.
 *   - Retorna { ok: true, notes } | { ok: false }.
 *   - El mensaje real del fallo va a console.error (nunca al body).
 */

export interface HealthProbeOptions {
  /** Función que devuelve la cantidad de notas (usa rawPrisma en producción). */
  countNotes: () => Promise<number>
  /** Timeout del sondeo en ms (default 3000). */
  timeoutMs?: number
  /** Tiempo máximo de un sondeo antes de descartarlo y crear uno nuevo (default 30000). */
  staleMs?: number
  /** Fuente de tiempo; inyectada en tests. */
  now?: () => number
}

export type HealthResult = { ok: true; notes: number } | { ok: false }

export function createHealthProbe({
  countNotes,
  timeoutMs = 3000,
  staleMs = 30000,
  now = Date.now,
}: HealthProbeOptions): () => Promise<HealthResult> {
  let probePromise: Promise<number> | null = null
  let probeStartedAt = 0

  return async function probe(): Promise<HealthResult> {
    const currentNow = now()

    // Crear nuevo sondeo si no hay uno, o si el actual lleva > staleMs (sondeo colgado)
    // Al asentarse (resolve o reject), limpiar probePromise para que la siguiente
    // request lance un sondeo nuevo — solo se comparte mientras esté pendiente.
    // Usamos .then(clear, clear) en lugar de .finally(clear): cuando countNotes()
    // rechaza inmediatamente, .finally() propaga la excepción como promesa rechazada
    // no manejada que Bun (y Node.js ≥ 15) eleva a error; .then(cb, cb) siempre resuelve.
    if (!probePromise || currentNow - probeStartedAt > staleMs) {
      probeStartedAt = currentNow
      const p = countNotes()
      probePromise = p
      const clear = (): void => { if (probePromise === p) probePromise = null }
      p.then(clear, clear)
    }

    // Race entre el sondeo compartido y el timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('health probe timeout')), timeoutMs),
    )

    try {
      const notes = await Promise.race([probePromise, timeoutPromise])
      return { ok: true, notes }
    } catch (err) {
      console.error('[cortex] health probe error:', err)
      return { ok: false }
    }
  }
}
