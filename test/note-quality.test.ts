/**
 * test/note-quality.test.ts — Heurísticas de clasificación de notas.
 *
 * Cubre los criterios de aceptación del issue #15 en la capa pura (sin BD ni modelo):
 *   - Una bitácora se detecta (título de registro, MR/PR en el título, fecha al inicio)
 *   - Una nota de conocimiento no se marca como bitácora
 *   - `pitfall` sin causa/arreglo, `decision` sin alternativa y `flujo` sin pasos advierten
 *   - Una nota bien formada no devuelve warnings
 *   - El modo estricto se lee del entorno en cada llamada
 */
import { describe, test, expect, afterEach } from 'bun:test'
import {
  isJournalNote,
  journalField,
  noteWarnings,
  isStrictNotesMode,
} from '../src/db/note-quality.ts'

afterEach(() => {
  delete process.env.CORTEX_STRICT_NOTES
})

describe('isJournalNote', () => {
  test('título de cierre con referencia a MR es bitácora', () => {
    expect(isJournalNote('Cierre ABC-1: MR !93 mergeado')).toBe(true)
  })

  test('título que arranca con fecha es bitácora', () => {
    expect(isJournalNote('2026-11-17 sesión de pair programming')).toBe(true)
  })

  test('referencia a PR en el título es bitácora', () => {
    expect(isJournalNote('Ajuste del dedupe (PR #18)')).toBe(true)
  })

  test('cuerpo que arranca con fecha es bitácora', () => {
    expect(isJournalNote('Trabajo del lunes', '2026-11-17\n\nSe avanzó en el dedupe.')).toBe(true)
  })

  test('nota de conocimiento no es bitácora', () => {
    expect(
      isJournalNote(
        'El modo estricto rechaza bitácoras cuando CORTEX_STRICT_NOTES está activo',
        'Porque el corpus se llenaba de registros de actividad. Se decidió advertir por defecto.',
      ),
    ).toBe(false)
  })

  test('journalField señala el campo donde se detectó el patrón', () => {
    expect(journalField('Cierre ABC-1: MR !93 mergeado', 'cuerpo')).toBe('title')
    expect(journalField('Trabajo del lunes', '2026-11-17\navances')).toBe('body_md')
  })
})

describe('noteWarnings', () => {
  test('bitácora advierte aunque el kind sea válido', () => {
    const warnings = noteWarnings({
      title: 'Cierre ABC-1: MR !93 mergeado',
      body_md: '## Qué se hizo\n- Merge del MR !93',
      kind: 'decision',
    })
    expect(warnings.some((w) => w.includes('bitácora'))).toBe(true)
  })

  test('pitfall sin causa ni arreglo advierte con el esqueleto esperado', () => {
    const warnings = noteWarnings({
      title: 'El dedupe devuelve falsos positivos',
      body_md: 'A veces dos notas distintas se consideran duplicadas.',
      kind: 'pitfall',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('pitfall')
    expect(warnings[0]).toContain('## Causa')
    expect(warnings[0]).toContain('## Arreglo')
  })

  test('pitfall con causa y arreglo no advierte', () => {
    const warnings = noteWarnings({
      title: 'El dedupe devuelve falsos positivos con notas cortas',
      body_md:
        '## Síntoma\nDos notas distintas se consideran duplicadas.\n\n' +
        '## Causa\nEl umbral es fijo y las notas cortas tienen coseno alto.\n\n' +
        '## Arreglo\nSe agregó el margen entre el primero y el segundo candidato.',
      kind: 'pitfall',
    })
    expect(warnings).toEqual([])
  })

  test('decision sin alternativa advierte', () => {
    const warnings = noteWarnings({
      title: 'Se usa ULID como id de nota',
      body_md: 'Los ids son ULID.',
      kind: 'decision',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Alternativa descartada')
  })

  test('decision con motivo y alternativa no advierte', () => {
    const warnings = noteWarnings({
      title: 'Se usa ULID como id de nota',
      body_md:
        '## Decisión\nSe usa ULID.\n\n## Alternativa descartada\nEl autoincremental se descartó porque filtra el volumen de escritura.',
      kind: 'decision',
    })
    expect(warnings).toEqual([])
  })

  test('flujo sin pasos advierte con el esqueleto esperado', () => {
    const warnings = noteWarnings({
      title: 'Aprobación de crédito hipotecario',
      body_md: 'El flujo requiere validación del central de riesgo y confirmación del ejecutivo.',
      kind: 'flujo',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('## Pasos')
  })

  test('flujo con lista de pasos no advierte', () => {
    const warnings = noteWarnings({
      title: 'Aprobación de crédito hipotecario',
      body_md: '## Pasos\n1. Validar central de riesgo\n2. Calcular tasa UF\n3. Confirmar ejecutivo',
      kind: 'flujo',
    })
    expect(warnings).toEqual([])
  })

  test('una nota bien formada no devuelve warnings (no-regresión)', () => {
    const warnings = noteWarnings({
      title: 'La app de cartera usa UF para los montos de crédito',
      body_md:
        'Todos los montos de crédito hipotecario se guardan en UF, no en pesos. ' +
        'La conversión a pesos ocurre solo en la capa de presentación.',
      kind: 'sistema',
    })
    expect(warnings).toEqual([])
  })

  test('regla y sistema no tienen heurística de forma', () => {
    expect(noteWarnings({ title: 'Regla de PRs', body_md: 'Todo entra por PR.', kind: 'regla' })).toEqual([])
  })
})

describe('isStrictNotesMode', () => {
  test('apagado por defecto', () => {
    expect(isStrictNotesMode()).toBe(false)
  })

  test('se lee del entorno en cada llamada', () => {
    process.env.CORTEX_STRICT_NOTES = '1'
    expect(isStrictNotesMode()).toBe(true)
    process.env.CORTEX_STRICT_NOTES = '0'
    expect(isStrictNotesMode()).toBe(false)
    process.env.CORTEX_STRICT_NOTES = 'true'
    expect(isStrictNotesMode()).toBe(true)
  })
})
