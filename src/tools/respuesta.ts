/**
 * src/tools/respuesta.ts — Serialización compacta y tope de respuestas (D7, D8).
 *
 * - `respuestaJson`: serializa sin indentar; los 8 handlers la usan para que nadie
 *   vuelva a poner `null, 2` y el tope viva junto a la serialización.
 * - `acotarLista`: tope 20.000 chars para cortex_list; quita ítems del final.
 * - `acotarHistorial`: tope 20.000 chars para cortex_history; quita los de menor rev.
 */

export const MAX_RESPUESTA_CHARS = 20000

/** `JSON.stringify` sin indentación. Usado por todos los handlers del MCP server. */
export function respuestaJson(valor: unknown): string {
  return JSON.stringify(valor)
}

// ─── Tipos de resultado ────────────────────────────────────────────────────────

export type AcotarListaResult = {
  total: number
  items: unknown[]
  next_offset: number | null
  truncated?: true
}

export type AcotarHistorialResult = {
  total: number
  items: unknown[]
  truncated?: true
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Acota la respuesta de cortex_list a MAX_RESPUESTA_CHARS.
 *
 * Algoritmo (D8):
 *  - Serializa el objeto completo; si supera el tope y hay más de un ítem,
 *    quita el último (orden temporal: los más recientes primero por updated_at desc) de uno en uno.
 *  - Siempre deja al menos un ítem, aunque ese solo ítem supere el tope.
 *  - `truncated: true` solo si se quitó alguno.
 *  - `next_offset` = offset + ítems conservados, o null si offset + conservados ≥ total.
 */
export function acotarLista({
  total,
  items,
  offset,
}: {
  total: number
  items: unknown[]
  offset: number
}): AcotarListaResult {
  let arr = [...items]
  let truncated = false

  const build = (): AcotarListaResult => {
    const conservados = arr.length
    const next_offset = offset + conservados >= total ? null : offset + conservados
    return {
      total,
      items: arr,
      next_offset,
      ...(truncated ? { truncated: true as const } : {}),
    }
  }

  while (JSON.stringify(build()).length > MAX_RESPUESTA_CHARS && arr.length > 1) {
    arr.pop()
    truncated = true
  }

  return build()
}

/**
 * Acota la respuesta de cortex_history a MAX_RESPUESTA_CHARS.
 *
 * Algoritmo (D8):
 *  - Serializa el objeto completo; si supera el tope y hay más de un ítem,
 *    quita el primer ítem (el de menor rev, que es el más antiguo) de uno en uno.
 *  - Siempre deja al menos un ítem.
 *  - `truncated: true` solo si se quitó alguno.
 */
export function acotarHistorial({
  total,
  items,
}: {
  total: number
  items: unknown[]
}): AcotarHistorialResult {
  let arr = [...items]
  let truncated = false

  const build = (): AcotarHistorialResult => {
    return {
      total,
      items: arr,
      ...(truncated ? { truncated: true as const } : {}),
    }
  }

  while (JSON.stringify(build()).length > MAX_RESPUESTA_CHARS && arr.length > 1) {
    arr.shift() // quita el más antiguo (menor rev, primero en el array)
    truncated = true
  }

  return build()
}
