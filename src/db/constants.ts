/**
 * Umbrales y constantes del núcleo — sin flags de configuración.
 * Los valores vienen de medición real sobre contenido del equipo (Decisión 4 y 5).
 */

/** Similarity coseno por debajo de la cual el resultado semántico se descarta antes de fusionar. */
export const SEMANTIC_DISCARD_THRESHOLD = 0.25

/** Similitud coseno a partir de la cual una nota candidata se considera duplicado. */
export const DUPLICATE_THRESHOLD = 0.55

/** Parámetro k de Reciprocal Rank Fusion (valor estándar bibliográfico). */
export const RRF_K = 60

/** Enum cerrado de kinds válidos para una nota. */
export const NOTE_KINDS = ['sistema', 'flujo', 'decision', 'pitfall', 'regla', 'otro'] as const

export type NoteKind = typeof NOTE_KINDS[number]
