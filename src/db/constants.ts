/**
 * Umbrales y constantes del núcleo — el umbral de duplicados es configurable
 * por variable de entorno; los demás vienen de medición real (Decisión 4 y 5).
 */
import { Prisma } from '@prisma/client'

/** Similarity coseno por debajo de la cual el resultado semántico se descarta antes de fusionar. */
export const SEMANTIC_DISCARD_THRESHOLD = 0.25

/** Umbral de duplicados por defecto (0.75). Sobrescribible con CORTEX_DUPLICATE_THRESHOLD. */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.75

/** Margen de coseno adicional cuando el candidato y la nota nueva difieren en kind o issue. */
export const DUPLICATE_DISTINCT_MARGIN = 0.1

/** Similitud de título (pg_trgm) a partir de la cual mismo-issue marca como duplicado. */
export const TITLE_SIMILARITY_THRESHOLD = 0.6

/**
 * Ventana del snippet de búsqueda: `ts_headline` devuelve el fragmento donde matcheó el
 * término, no los primeros caracteres del cuerpo (que pueden no contenerlo).
 * El cuerpo se pasa por `unaccent` para que el resaltado use la misma normalización
 * que el índice FTS: sin eso, buscar «evaluacion» no resalta «evaluación».
 */
const HEADLINE_OPTIONS = 'MaxWords=35,MinWords=15'

export function headlineSnippet(query: string): Prisma.Sql {
  return Prisma.sql`ts_headline('spanish', unaccent(body_md), websearch_to_tsquery('spanish', unaccent(${query})), ${HEADLINE_OPTIONS})`
}

/**
 * Quita los marcadores `<b>` que `ts_headline` intercala en el fragmento: al agente le
 * sirve el contexto, no el resaltado, y los marcadores cortan el término en pedazos.
 */
export function cleanSnippet(text: string): string {
  return text.replace(/<\/?b>/g, '')
}

/**
 * Lee el umbral de duplicados del entorno.
 * - Ausente o cadena vacía → 0.75 (DEFAULT_DUPLICATE_THRESHOLD).
 * - No finito, ≤ 0 o > 1 → lanza Error con CORTEX_DUPLICATE_THRESHOLD, el valor y pista de formato.
 */
export function duplicateThreshold(env: Record<string, string | undefined> = process.env): number {
  const raw = env['CORTEX_DUPLICATE_THRESHOLD']
  if (raw === undefined || raw === '') return DEFAULT_DUPLICATE_THRESHOLD
  const trimmed = raw.trim()
  if (trimmed === '') return DEFAULT_DUPLICATE_THRESHOLD
  const value = Number(trimmed)
  if (!isFinite(value) || value <= 0 || value > 1) {
    throw new Error(
      `CORTEX_DUPLICATE_THRESHOLD="${raw}" no es un número válido entre 0 (excluido) y 1 (incluido). Usá punto decimal (ej. 0.75).`,
    )
  }
  return value
}

/** Parámetro k de Reciprocal Rank Fusion (valor estándar bibliográfico). */
export const RRF_K = 60

/** Enum cerrado de kinds válidos para una nota. */
export const NOTE_KINDS = ['sistema', 'flujo', 'decision', 'pitfall', 'regla'] as const

export type NoteKind = typeof NOTE_KINDS[number]

/**
 * Significado de cada tipo — única fuente para el schema de las tools y la documentación.
 * El `Record<NoteKind, string>` obliga a que exista una entrada por cada tipo de `NOTE_KINDS`.
 */
export const NOTE_KIND_DESCRIPTIONS: Record<NoteKind, string> = {
  sistema: 'cómo funciona un sistema o módulo (qué hace, cómo se usa)',
  flujo: 'un proceso con pasos u orden que importa, y sus trampas',
  decision: 'por qué se decidió algo, con su contexto y la alternativa descartada',
  pitfall: 'una trampa o error ya sufrido, con su causa y su arreglo',
  regla: 'una regla del equipo que no está escrita en el código',
}

/**
 * Expresión SQL normalizada para el campo issue — coincide exactamente con el índice
 * notes_issue_idx. El planner solo usa el índice si la expresión de la consulta coincide
 * con la declarada en la migración (Design D3).
 */
export const ISSUE_NORMALIZED_SQL = Prisma.raw('lower(btrim(issue))')
