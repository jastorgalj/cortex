/**
 * src/tools/sessions.ts — Registro de sesiones MCP con TTL y barrido.
 *
 * SessionRegistry: add, get (renueva lastSeen), delete, sweep, closeAll, size.
 * parseSessionTtlMinutes: parsea MCP_SESSION_TTL_MINUTES con fallback a 1440.
 */

export type SessionMotivo = 'delete' | 'ttl' | 'shutdown'

export interface SessionTransport {
  handleRequest(request: Request): Response | Promise<Response>
  close(): void | Promise<void>
}

interface SessionEntry {
  transport: SessionTransport
  lastSeen: number
}

export class SessionRegistry {
  private sessions = new Map<string, SessionEntry>()

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Registra una sesión nueva y escribe en el log.
   */
  add(id: string, transport: SessionTransport): void {
    this.sessions.set(id, { transport, lastSeen: this.now() })
    console.log(`[cortex] sesión creada ${id.slice(0, 8)} (activas: ${this.sessions.size})`)
  }

  /**
   * Devuelve el transport y renueva lastSeen.
   * Devuelve undefined si la sesión no existe.
   */
  get(id: string): SessionTransport | undefined {
    const entry = this.sessions.get(id)
    if (!entry) return undefined
    entry.lastSeen = this.now()
    return entry.transport
  }

  /**
   * Elimina la sesión, cierra su transport y escribe en el log.
   */
  delete(id: string, motivo: SessionMotivo): void {
    const entry = this.sessions.get(id)
    if (!entry) return
    this.sessions.delete(id)
    entry.transport.close()
    console.log(`[cortex] sesión cerrada ${id.slice(0, 8)} motivo=${motivo} (activas: ${this.sessions.size})`)
  }

  /**
   * Elimina sesiones cuyo lastSeen esté más de ttlMs ms en el pasado.
   * @param nowMs  Tiempo actual en ms (inyectado para facilitar tests).
   * @param ttlMs  TTL en ms.
   */
  sweep(nowMs: number, ttlMs: number): void {
    for (const [id, entry] of this.sessions) {
      if (nowMs - entry.lastSeen > ttlMs) {
        this.delete(id, 'ttl')
      }
    }
  }

  /**
   * Cierra todas las sesiones activas.
   */
  closeAll(motivo: SessionMotivo): void {
    for (const id of [...this.sessions.keys()]) {
      this.delete(id, motivo)
    }
  }

  get size(): number {
    return this.sessions.size
  }
}

/**
 * Parsea la variable de entorno MCP_SESSION_TTL_MINUTES.
 * - undefined → 1440 (24 h)
 * - no numérico o < 1 → 1440 y console.warn
 */
export function parseSessionTtlMinutes(raw: string | undefined): number {
  if (raw === undefined) return 1440
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) {
    console.warn(
      `[cortex] MCP_SESSION_TTL_MINUTES: valor inválido '${raw}', usando 1440 por defecto`,
    )
    return 1440
  }
  return n
}
