/**
 * Calidad de una nota: heurísticas de clasificación.
 *
 * `kind` se valida contra un enum cerrado, pero el enum no dice si el contenido
 * calza con el tipo. Acá viven las dos señales que la tool devuelve al agente:
 *   - `isJournalNote`: el contenido parece bitácora (registro de actividad) y no
 *     conocimiento reutilizable. En modo `strict` (env `CORTEX_STRICT_NOTES`) se
 *     rechaza; por defecto solo se advierte.
 *   - `noteWarnings`: el contenido no tiene la forma que su `kind` promete
 *     (decisión sin alternativa, pitfall sin causa/arreglo, flujo sin pasos).
 *
 * Funciones puras, sin IO: se testean sin base de datos ni modelo de embeddings.
 * Las heurísticas son deliberadamente simples — una advertencia falsa cuesta poco
 * (no bloquea), una compleja cuesta mantenimiento y confianza.
 */

import { NOTE_KIND_DESCRIPTIONS, type NoteKind } from './constants.ts'

/** Título que arranca como registro de actividad, no como conocimiento. */
const JOURNAL_TITLE = /^(cierre|avance|log|bit[aá]cora|sesi[oó]n|daily|standup)\b/i

/** Referencia a un merge request / PR: típico de un cierre de ticket. */
const JOURNAL_REFERENCE = /\b(MR !\d+|PR #\d+)/i

/** Fecha ISO al principio del título o de la primera línea del cuerpo. */
const LEADING_DATE = /^\s*\d{4}-\d{2}-\d{2}\b/

/** Marcadores de motivo/alternativa que una `decision` debería tener. */
const DECISION_MARKERS =
  /(porque|por qu[eé]|decid|decisi[oó]n|alternativa|descart|en vez de|trade-?off|motivo|raz[oó]n|a cambio|se prefiri[oó])/i

/** Marcadores de causa en un `pitfall`. */
const PITFALL_CAUSE = /(causa|porque|debido|se debe|origen|motivo|provoc|root cause|por culpa)/i

/** Marcadores de arreglo en un `pitfall`. */
const PITFALL_FIX =
  /(arregl|soluci[oó]n|solucion|fix|correg|parche|workaround|se resuelve|remedi|se evita)/i

/** Línea que abre un ítem de lista (numerada o con viñeta). */
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*+])[ \t]+\S/gm

/**
 * Modo estricto: `CORTEX_STRICT_NOTES=1` (o `true`) rechaza las bitácoras en vez
 * de solo advertir. Se lee en cada llamada para que el flag no quede congelado al
 * importar el módulo (los tests lo prenden y apagan).
 */
export function isStrictNotesMode(): boolean {
  const value = (process.env.CORTEX_STRICT_NOTES ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

/**
 * true si el texto parece bitácora: título de registro de actividad, referencia a
 * un MR/PR en el título, o fecha al inicio del título o del cuerpo.
 */
export function isJournalNote(title: string, body_md = ''): boolean {
  if (JOURNAL_TITLE.test(title)) return true
  if (JOURNAL_REFERENCE.test(title)) return true
  if (LEADING_DATE.test(title)) return true

  const firstLine = body_md.split('\n').find((line) => line.trim() !== '') ?? ''
  return LEADING_DATE.test(firstLine)
}

/** Campo donde se detectó el patrón de bitácora (para el `ValidationError`). */
export function journalField(title: string, body_md = ''): 'title' | 'body_md' {
  if (JOURNAL_TITLE.test(title) || JOURNAL_REFERENCE.test(title) || LEADING_DATE.test(title)) {
    return 'title'
  }
  return 'body_md'
}

function looksLikeSteps(body: string): boolean {
  const items = body.match(LIST_ITEM)?.length ?? 0
  return items >= 2 || /^\s*#{1,6}\s*(pasos|procedimiento)\b/im.test(body)
}

/**
 * Advertencias no bloqueantes sobre la forma del contenido frente a su `kind`.
 * Lista vacía cuando la nota calza (o cuando el tipo no tiene heurística).
 */
export function noteWarnings(note: {
  title: string
  body_md: string
  kind: string
}): string[] {
  const warnings: string[] = []
  const { title, body_md: body, kind } = note
  const text = `${title}\n${body}`

  if (isJournalNote(title, body)) {
    warnings.push(
      'parece bitácora (registro de actividad), no conocimiento reutilizable: ' +
        'extraé la decisión, la regla o el pitfall que deja el trabajo y guardá eso; ' +
        'si no hay nada reutilizable, no la guardes.',
    )
  }

  switch (kind as NoteKind) {
    case 'decision':
      if (!DECISION_MARKERS.test(text)) {
        warnings.push(
          `kind=decision sin motivo ni alternativa descartada — ${NOTE_KIND_DESCRIPTIONS.decision}. ` +
            'Esqueleto esperado: ## Contexto / ## Decisión / ## Alternativa descartada (y por qué).',
        )
      }
      break
    case 'pitfall':
      if (!PITFALL_CAUSE.test(text) || !PITFALL_FIX.test(text)) {
        warnings.push(
          `kind=pitfall sin causa o sin arreglo — ${NOTE_KIND_DESCRIPTIONS.pitfall}. ` +
            'Esqueleto esperado: ## Síntoma / ## Causa / ## Arreglo.',
        )
      }
      break
    case 'flujo':
      if (!looksLikeSteps(body)) {
        warnings.push(
          `kind=flujo sin lista de pasos — ${NOTE_KIND_DESCRIPTIONS.flujo}. ` +
            'Esqueleto esperado: ## Pasos (lista numerada) / ## Trampas.',
        )
      }
      break
    default:
      break
  }

  return warnings
}
