/**
 * src/tools/args.ts — Alias de argumentos y resolución de author para las tools MCP.
 * Sin I/O, sin importar Prisma ni el SDK.
 */

/** Mapa de aliases por tool: canonical → [alias1, alias2, ...] */
export const TOOL_ALIASES: Record<string, Record<string, string[]>> = {
  cortex_search: { q: ['query', 'text'] },
  cortex_write: { body_md: ['body', 'content', 'markdown'] },
  cortex_update: { body_md: ['body', 'content', 'markdown'] },
}

export type NormalizeOk = { ok: true; args: Record<string, unknown> }
export type NormalizeConflict = { ok: false; a: string; b: string; canonical: string }
export type NormalizeResult = NormalizeOk | NormalizeConflict

/**
 * Normaliza los argumentos de una tool reemplazando alias por su clave canónica.
 *
 * - Si la tool no tiene aliases o ningún alias está presente, devuelve el mismo objeto (sin copia).
 * - Si alias y canónico traen el mismo valor (`===`), elimina los alias y deja el canónico.
 * - Si algún alias/canónico trae un valor distinto, devuelve `{ok:false, a, b, canonical}`.
 * - No muta el objeto recibido.
 */
export function normalizeToolArgs(
  tool: string,
  args: Record<string, unknown>,
): NormalizeResult {
  const aliases = TOOL_ALIASES[tool]
  if (!aliases) return { ok: true, args }

  // Verificar si hay al menos un alias presente
  let anyAlias = false
  outer: for (const aliasList of Object.values(aliases)) {
    for (const alias of aliasList) {
      if (args[alias] !== undefined) {
        anyAlias = true
        break outer
      }
    }
  }
  if (!anyAlias) return { ok: true, args }

  // Construir args normalizados (copia del objeto original)
  const result: Record<string, unknown> = { ...args }

  for (const [canonical, aliasList] of Object.entries(aliases)) {
    // Recolectar todas las claves presentes (canónica + aliases con valor !== undefined)
    const present: Array<{ key: string; val: unknown }> = []
    if (result[canonical] !== undefined) {
      present.push({ key: canonical, val: result[canonical] })
    }
    for (const alias of aliasList) {
      if (result[alias] !== undefined) {
        present.push({ key: alias, val: result[alias] })
      }
    }

    if (present.length <= 1) {
      // Sin alias presente o solo uno (puede ser solo un alias sin canónico)
      if (present.length === 1 && present[0]!.key !== canonical) {
        result[canonical] = present[0]!.val
        delete result[present[0]!.key]
      }
      continue
    }

    // Varias claves presentes: detectar conflicto (dos valores distintos)
    const firstVal = present[0]!.val
    const conflicting = present.find(({ val }) => val !== firstVal)
    if (conflicting) {
      return { ok: false, a: present[0]!.key, b: conflicting.key, canonical }
    }

    // Mismo valor en todas: conservar canónica, eliminar alias
    if (result[canonical] === undefined) {
      result[canonical] = firstVal
    }
    for (const alias of aliasList) {
      delete result[alias]
    }
  }

  return { ok: true, args: result }
}

/**
 * Resuelve el autor siguiendo la cadena: argument > header > clientName > 'agente'.
 * Devuelve el primer valor no vacío tras trim().
 *
 * El handler de cortex_write/cortex_update evalúa `argument` antes de llamar esta función:
 * si llega explícito y vacío, devuelve error; si es undefined, llama resolveAuthor sin argument.
 */
export function resolveAuthor({
  argument,
  header,
  clientName,
}: {
  argument?: string
  header?: string | string[]
  clientName?: string
}): string {
  const headerStr = Array.isArray(header) ? header[0] : header
  if (argument?.trim()) return argument
  if (headerStr?.trim()) return headerStr
  if (clientName?.trim()) return clientName
  return 'agente'
}
