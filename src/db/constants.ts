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
