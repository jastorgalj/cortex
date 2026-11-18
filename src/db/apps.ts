/**
 * src/db/apps.ts — vocabulario de `app`: normalización, alias y modo de validación.
 *
 * `app` es la llave del sistema al que pertenece una nota. Sin vocabulario se acepta
 * cualquier valor (con `trim().toLowerCase()`); con `CORTEX_APPS` declarado, un valor
 * fuera de la lista se acepta con `warnings` (modo `warn`, default) o se rechaza
 * (modo `strict`). Los alias existen para que un valor viejo o abreviado escriba el
 * canónico, sin migrar datos.
 *
 * Configuración por entorno, leída en cada llamada (los tests la cambian por proceso):
 *   CORTEX_APPS          lista canónica separada por comas; vacía/ausente = sin vocabulario
 *   CORTEX_APP_ALIASES   JSON {"valor-viejo":"canónico"} (claves y valores normalizados)
 *   CORTEX_APP_MODE      `warn` (default) | `strict`
 *
 * `general` es la app transversal: siempre es un valor válido y los filtros la incluyen
 * salvo que se pida lo contrario (`include_general: false`).
 */

/** App transversal: reglas y convenciones que aplican a cualquier sistema. */
export const GENERAL_APP = 'general'

export type AppMode = 'warn' | 'strict'

export type AppConfig = {
  /** Vocabulario canónico declarado. Vacío ⇒ no hay vocabulario y todo valor se acepta. */
  apps: string[]
  /** Alias normalizado → valor canónico normalizado. */
  aliases: Record<string, string>
  mode: AppMode
}

export type AppResolution =
  | { ok: true; app: string; warnings: string[] }
  | { ok: false; message: string }

function normalizeAppKey(raw: string): string {
  return raw.trim().toLowerCase()
}

/** Lee el vocabulario del entorno. Función (no constante) para que los tests lo varíen. */
export function getAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const apps = [
    ...new Set(
      (env.CORTEX_APPS ?? '')
        .split(',')
        .map(normalizeAppKey)
        .filter((a) => a.length > 0),
    ),
  ]

  const aliases: Record<string, string> = {}
  const rawAliases = env.CORTEX_APP_ALIASES?.trim()
  if (rawAliases) {
    try {
      const parsed = JSON.parse(rawAliases) as Record<string, unknown>
      for (const [from, to] of Object.entries(parsed)) {
        if (typeof to !== 'string') continue
        const key = normalizeAppKey(from)
        const value = normalizeAppKey(to)
        if (key && value) aliases[key] = value
      }
    } catch {
      // JSON inválido: se ignora el mapa de alias y se sigue con el vocabulario.
      // No es un error fatal — un servidor que no arranca por una env mal escrita
      // pierde más de lo que gana.
    }
  }

  return { apps, aliases, mode: env.CORTEX_APP_MODE === 'strict' ? 'strict' : 'warn' }
}

/** Valor canónico de una app: normaliza y aplica alias. No valida contra el vocabulario. */
export function canonicalApp(raw: string, config: AppConfig = getAppConfig()): string {
  const key = normalizeAppKey(raw)
  return config.aliases[key] ?? key
}

/**
 * Resuelve la app de una escritura: normaliza, aplica alias y valida el vocabulario.
 * - alias conocido → escribe el canónico, sin warning;
 * - valor fuera del vocabulario en modo `warn` → se acepta y devuelve el aviso;
 * - en modo `strict` → `ok: false` con la lista de valores válidos.
 */
export function resolveApp(raw: string, config: AppConfig = getAppConfig()): AppResolution {
  const app = canonicalApp(raw, config)
  if (!app) return { ok: false, message: 'El campo app no puede estar vacío' }

  if (config.apps.length === 0 || config.apps.includes(app) || app === GENERAL_APP) {
    return { ok: true, app, warnings: [] }
  }

  const valid = [...new Set([...config.apps, GENERAL_APP])].sort().join(', ')
  const message =
    `app desconocida: "${raw}". Valores válidos: ${valid}. ` +
    'Si el valor es un nombre viejo o una abreviatura, agregalo a CORTEX_APP_ALIASES.'

  if (config.mode === 'strict') return { ok: false, message }
  return { ok: true, app, warnings: [message] }
}

/**
 * Valores de `app` que debe traer un filtro: la app pedida (canónica) y `general`,
 * que es transversal. `include_general: false` deja solo la app pedida.
 *
 * Un filtro no rechaza valores desconocidos (no escribe nada): solo normaliza y
 * resuelve alias, para que `app: "Back"` siga encontrando lo guardado como `backend`.
 */
export function appFilterValues(
  raw: string,
  includeGeneral = true,
  config: AppConfig = getAppConfig(),
): string[] {
  const app = canonicalApp(raw, config)
  return includeGeneral ? [...new Set([app, GENERAL_APP])] : [app]
}
