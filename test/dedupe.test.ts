/**
 * test/dedupe.test.ts — Tasks 2.4, 3.3, 3.4, 4.5: deduplicación con umbral,
 * clasificador, candidatas enriquecidas y force con reason.
 *
 * Bloque 1 (sin modelo ni BD): duplicateThreshold y classifyCandidate con números explícitos.
 * Bloque 2 (con modelo y BD): tests de integración — guard de fixture + escenarios del issue.
 * Bloque 3 (con BD): force + reason persistence.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import {
  createNote,
  readNote,
  ValidationError,
  classifyCandidate,
} from '../src/db/notes.ts'
import { duplicateThreshold } from '../src/db/constants.ts'
import { embed, warmup } from '../src/db/embeddings.ts'

// ─── Bloque 1: Unitarios sin modelo ni BD ────────────────────────────────────

describe('duplicateThreshold', () => {
  test('ausente → 0.75', () => {
    expect(duplicateThreshold({})).toBe(0.75)
  })
  test("'' → 0.75", () => {
    expect(duplicateThreshold({ CORTEX_DUPLICATE_THRESHOLD: '' })).toBe(0.75)
  })
  test("'0.9' → 0.9", () => {
    expect(duplicateThreshold({ CORTEX_DUPLICATE_THRESHOLD: '0.9' })).toBeCloseTo(0.9)
  })
  test("' 0.8 ' → 0.8 (espacios recortados)", () => {
    expect(duplicateThreshold({ CORTEX_DUPLICATE_THRESHOLD: ' 0.8 ' })).toBeCloseTo(0.8)
  })
  test("'1' → 1 (límite inclusivo)", () => {
    expect(duplicateThreshold({ CORTEX_DUPLICATE_THRESHOLD: '1' })).toBe(1)
  })
  test("'abc' → lanza con CORTEX_DUPLICATE_THRESHOLD en el mensaje", () => {
    expect(() => duplicateThreshold({ CORTEX_DUPLICATE_THRESHOLD: 'abc' })).toThrow(
      'CORTEX_DUPLICATE_THRESHOLD',
    )
  })
  test("'0' → lanza (≤ 0)", () => {
    expect(() => duplicateThreshold({ CORTEX_DUPLICATE_THRESHOLD: '0' })).toThrow(
      'CORTEX_DUPLICATE_THRESHOLD',
    )
  })
  test("'1.5' → lanza (> 1)", () => {
    expect(() => duplicateThreshold({ CORTEX_DUPLICATE_THRESHOLD: '1.5' })).toThrow(
      'CORTEX_DUPLICATE_THRESHOLD',
    )
  })
  test("'0,75' → lanza (coma decimal)", () => {
    expect(() => duplicateThreshold({ CORTEX_DUPLICATE_THRESHOLD: '0,75' })).toThrow(
      'CORTEX_DUPLICATE_THRESHOLD',
    )
  })
  test("'-0.1' → lanza (negativo)", () => {
    expect(() => duplicateThreshold({ CORTEX_DUPLICATE_THRESHOLD: '-0.1' })).toThrow(
      'CORTEX_DUPLICATE_THRESHOLD',
    )
  })
})

describe('classifyCandidate', () => {
  const T = 0.75

  test('(0.80, mismo kind, sin issue) → coseno', () => {
    const r = classifyCandidate(
      { score: 0.80, title_sim: 0, kind: 'regla', issue: null },
      { kind: 'regla' },
      T,
    )
    expect(r?.matched_by).toBe('coseno')
    expect(r?.same_kind).toBe(true)
    expect(r?.same_issue).toBe(false)
  })

  test('(0.80, distinto kind, sin issue) → null (margen +0.1 no alcanzado)', () => {
    const r = classifyCandidate(
      { score: 0.80, title_sim: 0, kind: 'decision', issue: null },
      { kind: 'regla' },
      T,
    )
    expect(r).toBeNull()
  })

  test('(0.86, distinto kind) → coseno con same_kind: false', () => {
    const r = classifyCandidate(
      { score: 0.86, title_sim: 0, kind: 'decision', issue: null },
      { kind: 'regla' },
      T,
    )
    expect(r?.matched_by).toBe('coseno')
    expect(r?.same_kind).toBe(false)
  })

  test('(0.80, mismo kind, issues A-1 vs A-2) → null (issue distinto activa margen)', () => {
    const r = classifyCandidate(
      { score: 0.80, title_sim: 0, kind: 'regla', issue: 'A-1' },
      { kind: 'regla', issue: 'A-2' },
      T,
    )
    expect(r).toBeNull()
  })

  test('(0.86, issues A-1 vs A-2, kinds distintos) → coseno (margen una sola vez: 0.86 ≥ 0.85)', () => {
    const r = classifyCandidate(
      { score: 0.86, title_sim: 0, kind: 'decision', issue: 'A-1' },
      { kind: 'regla', issue: 'A-2' },
      T,
    )
    expect(r?.matched_by).toBe('coseno')
  })

  test('(0.80, un issue nulo) → coseno (no hay regla de issue: sin dos issues)', () => {
    const r = classifyCandidate(
      { score: 0.80, title_sim: 0, kind: 'regla', issue: null },
      { kind: 'regla', issue: 'A-1' },
      T,
    )
    expect(r?.matched_by).toBe('coseno')
  })

  test('(0.60, mismo issue A-1 vs a-1 trim, title_sim 0.70) → issue_y_titulo', () => {
    const r = classifyCandidate(
      { score: 0.60, title_sim: 0.70, kind: 'regla', issue: 'a-1' },
      { kind: 'regla', issue: ' A-1 ' },
      T,
    )
    expect(r?.matched_by).toBe('issue_y_titulo')
    expect(r?.same_issue).toBe(true)
  })

  test('(0.60, mismo issue, title_sim 0.59) → null (similitud título insuficiente)', () => {
    const r = classifyCandidate(
      { score: 0.60, title_sim: 0.59, kind: 'regla', issue: 'A-1' },
      { kind: 'regla', issue: 'A-1' },
      T,
    )
    expect(r).toBeNull()
  })

  test('(0.60, issues distintos, title_sim 0.95) → null', () => {
    const r = classifyCandidate(
      { score: 0.60, title_sim: 0.95, kind: 'regla', issue: 'A-1' },
      { kind: 'regla', issue: 'A-2' },
      T,
    )
    expect(r).toBeNull()
  })

  test('(0.60, ambos issue nulos, title_sim 0.95) → null (sin rule de issue)', () => {
    const r = classifyCandidate(
      { score: 0.60, title_sim: 0.95, kind: 'regla', issue: null },
      { kind: 'regla' },
      T,
    )
    expect(r).toBeNull()
  })

  test('(0.749, mismo kind) → null (justo bajo umbral)', () => {
    const r = classifyCandidate(
      { score: 0.749, title_sim: 0, kind: 'regla', issue: null },
      { kind: 'regla' },
      T,
    )
    expect(r).toBeNull()
  })

  test('(0.751, mismo kind) → coseno (justo sobre umbral)', () => {
    const r = classifyCandidate(
      { score: 0.751, title_sim: 0, kind: 'regla', issue: null },
      { kind: 'regla' },
      T,
    )
    expect(r?.matched_by).toBe('coseno')
  })
})

// ─── Bloque 2: Tests de integración con modelo real y BD ─────────────────────

const prisma = new PrismaClient()

// Fixtures (textos medidos el 2026-11-16 con Xenova/all-mpnet-base-v2)
const noteA = {
  title: 'MTD-390: decisión sobre el cálculo de la cuota mínima',
  body_md: 'La cuota mínima se calcula sobre el monto aprobado y no sobre el solicitado. Se descartó usar el monto solicitado porque riesgo puede aprobar menos.',
}
const noteB1 = {
  title: 'MTD-390: decisión del cálculo de la cuota mínima (QA)',
  body_md: 'QA ejecutó tres casos en DEV con el usuario de riesgo: monto aprobado igual al solicitado, menor y cero. Dos pasaron y uno quedó pendiente por un dato de prueba faltante.',
  // coseno con A ≈ 0.85; similitud de título ≈ 0.77
}
const noteB2 = {
  title: 'MTD-390: cierre del ticket y orden de despliegue',
  body_md: 'El ticket cierra con dos MRs: backend primero y frontend después. La cuota mínima se calcula sobre el monto aprobado, como se decidió. Se despliega primero en DEV.',
  // coseno con A ≈ 0.77; título ≈ 0.18
}
const noteFa = {
  title: 'Regla de acceso preferencial para clientes fundadores',
  body_md: 'Los clientes fundadores tienen acceso preferencial a créditos con tasas diferenciadas. Este beneficio se gestiona a través del módulo de categorías de clientes en el sistema cartera.',
}
const noteFb = {
  title: 'Acceso preferencial para clientes fundadores de la financiera',
  body_md: 'Los clientes fundadores tienen acceso preferencial a créditos con tasas diferenciadas. Este beneficio está gestionado por el módulo de categorías en el sistema cartera.',
  // coseno con Fa ≈ 0.97
}

const BASE = { app: 'general', author: 'dedupe-test', tags: [] }

beforeAll(async () => {
  await warmup()
})

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE notes CASCADE`
})

afterEach(async () => {
  // Restaurar env si un test la pisó
  delete process.env.CORTEX_DUPLICATE_THRESHOLD
})

describe('integración: findDuplicates con classifyCandidate', () => {
  test('(i) distinto kind → se crea; mismo kind → similar_exists', async () => {
    // Guard: mide c real entre A y B2
    const vA = await embed(noteA.title + ' ' + noteA.body_md)
    const vB2 = await embed(noteB2.title + ' ' + noteB2.body_md)
    const c = vA.reduce((sum, v, i) => sum + v * vB2[i], 0)
    if (c < 0.70 || c > 0.84) throw new Error(`fixture desactualizado: re-medir. c A×B2 = ${c}`)

    const T = c - 0.02
    process.env.CORTEX_DUPLICATE_THRESHOLD = String(T)

    // A y B2 con distintos kind → se crea (margen +0.1; c ≥ T pero < T + 0.1 con mismo kind, no hay issue)
    // Con kind distinto se requiere c ≥ T + 0.1 → no alcanza → se crea
    const r1 = await createNote(prisma, {
      ...BASE,
      kind: 'decision',
      ...noteA,
    })
    expect(r1.status).toBe('created')

    const r2 = await createNote(prisma, {
      ...BASE,
      kind: 'sistema', // distinto
      ...noteB2,
    })
    expect(r2.status).toBe('created')

    // Con B2 mismo kind que A → similar_exists
    await prisma.$executeRaw`TRUNCATE notes CASCADE`
    await createNote(prisma, { ...BASE, kind: 'decision', ...noteA })

    const r3 = await createNote(prisma, {
      ...BASE,
      kind: 'decision',
      ...noteB2,
    })
    expect(r3.status).toBe('similar_exists')
  })

  test('(ii) distinto issue → se crea; btrim lowercase igual → similar_exists con coseno', async () => {
    const vA = await embed(noteA.title + ' ' + noteA.body_md)
    const vB2 = await embed(noteB2.title + ' ' + noteB2.body_md)
    const c = vA.reduce((sum, v, i) => sum + v * vB2[i], 0)
    if (c < 0.70 || c > 0.84) throw new Error(`fixture desactualizado: re-medir. c A×B2 = ${c}`)

    const T = c - 0.02
    process.env.CORTEX_DUPLICATE_THRESHOLD = String(T)

    await createNote(prisma, { ...BASE, kind: 'decision', issue: 'MTD-390', ...noteA })

    // Issue distinto → se crea (margen activa; c < T + 0.1 cuando los issues son distintos y mismo kind)
    const r1 = await createNote(prisma, {
      ...BASE,
      kind: 'decision',
      issue: 'MTD-391',
      ...noteB2,
    })
    expect(r1.status).toBe('created')

    // Issue 'mtd-390 ' (lowercase + espacio) → mismo issue tras btrim(lower) → coseno marca
    await prisma.$executeRaw`TRUNCATE notes CASCADE`
    await createNote(prisma, { ...BASE, kind: 'decision', issue: 'MTD-390', ...noteA })
    const r2 = await createNote(prisma, {
      ...BASE,
      kind: 'decision',
      issue: 'mtd-390 ',
      ...noteB2,
    })
    expect(r2.status).toBe('similar_exists')
    if (r2.status === 'similar_exists') {
      expect(r2.candidates[0].same_issue).toBe(true)
      expect(r2.candidates[0].matched_by).toBe('coseno')
    }
  })

  test('(iii) mismo issue y título casi igual → similar_exists via issue_y_titulo aunque coseno < T', async () => {
    // Guard de coseno (B1 y A)
    const vA = await embed(noteA.title + ' ' + noteA.body_md)
    const vB1 = await embed(noteB1.title + ' ' + noteB1.body_md)
    const c = vA.reduce((sum, v, i) => sum + v * vB1[i], 0)
    if (c >= 0.95) throw new Error(`fixture desactualizado: c A×B1 = ${c}, se esperaba < 0.95`)

    // Guard de similitud de título (consulta a la BD real)
    const titleSimRow = await prisma.$queryRaw<{ sim: number }[]>`
      SELECT similarity(unaccent(${noteA.title}), unaccent(${noteB1.title})) AS sim
    `
    const titleSim = Number(titleSimRow[0].sim)
    if (titleSim < 0.6)
      throw new Error(`fixture desactualizado: title_sim A×B1 = ${titleSim}, se esperaba ≥ 0.6`)

    // Umbral muy alto → coseno no marca; pero mismo issue + título alto → issue_y_titulo
    process.env.CORTEX_DUPLICATE_THRESHOLD = '0.95'

    await createNote(prisma, { ...BASE, kind: 'decision', issue: 'MTD-390', ...noteA })
    const r = await createNote(prisma, {
      ...BASE,
      kind: 'decision',
      issue: 'MTD-390',
      ...noteB1,
    })
    expect(r.status).toBe('similar_exists')
    if (r.status === 'similar_exists') {
      expect(r.candidates[0].same_issue).toBe(true)
      expect(r.candidates[0].matched_by).toBe('issue_y_titulo')
      expect(r.candidates[0].score).toBeLessThan(0.95)
    }
  })

  test('(iv) mismo issue y títulos distintos → se crea', async () => {
    const vA = await embed(noteA.title + ' ' + noteA.body_md)
    const vB2 = await embed(noteB2.title + ' ' + noteB2.body_md)
    const c = vA.reduce((sum, v, i) => sum + v * vB2[i], 0)
    if (c < 0.70 || c > 0.84) throw new Error(`fixture desactualizado: c A×B2 = ${c}`)

    // Guard de que title_sim A×B2 < 0.6
    const tsRow = await prisma.$queryRaw<{ sim: number }[]>`
      SELECT similarity(unaccent(${noteA.title}), unaccent(${noteB2.title})) AS sim
    `
    if (Number(tsRow[0].sim) >= 0.6)
      throw new Error(`fixture desactualizado: title_sim A×B2 = ${Number(tsRow[0].sim)}, se esperaba < 0.6`)

    process.env.CORTEX_DUPLICATE_THRESHOLD = '0.95'

    await createNote(prisma, { ...BASE, kind: 'decision', issue: 'MTD-390', ...noteA })
    const r = await createNote(prisma, {
      ...BASE,
      kind: 'decision',
      issue: 'MTD-390',
      ...noteB2,
    })
    expect(r.status).toBe('created')
  })

  test('(v) umbral por variable — T = c + 0.02 → se crea; T = c − 0.02 → similar_exists', async () => {
    const vA = await embed(noteA.title + ' ' + noteA.body_md)
    const vB2 = await embed(noteB2.title + ' ' + noteB2.body_md)
    const c = vA.reduce((sum, v, i) => sum + v * vB2[i], 0)
    if (c < 0.70 || c > 0.84) throw new Error(`fixture desactualizado: c A×B2 = ${c}`)

    // T = c + 0.02 → c < T → se crea (mismo kind, mismo issue ausente → sin margen)
    process.env.CORTEX_DUPLICATE_THRESHOLD = String(c + 0.02)
    await createNote(prisma, { ...BASE, kind: 'decision', ...noteA })
    const r1 = await createNote(prisma, { ...BASE, kind: 'decision', ...noteB2 })
    expect(r1.status).toBe('created')

    // T = c − 0.02 → c ≥ T → similar_exists
    await prisma.$executeRaw`TRUNCATE notes CASCADE`
    process.env.CORTEX_DUPLICATE_THRESHOLD = String(c - 0.02)
    await createNote(prisma, { ...BASE, kind: 'decision', ...noteA })
    const r2 = await createNote(prisma, { ...BASE, kind: 'decision', ...noteB2 })
    expect(r2.status).toBe('similar_exists')
  })

  test('(vi) candidata enriquecida trae app, kind, issue, updated_at, same_issue, same_kind, matched_by', async () => {
    const vFa = await embed(noteFa.title + ' ' + noteFa.body_md)
    const vFb = await embed(noteFb.title + ' ' + noteFb.body_md)
    const c = vFa.reduce((sum, v, i) => sum + v * vFb[i], 0)
    if (c < 0.9) throw new Error(`fixture desactualizado: c Fa×Fb = ${c}, se esperaba ≥ 0.9`)

    // Fa existe; Fb (distinto kind, con issue) → similar_exists bajo umbral default
    delete process.env.CORTEX_DUPLICATE_THRESHOLD

    await createNote(prisma, { ...BASE, app: 'cartera', kind: 'regla', ...noteFa })
    const r = await createNote(prisma, {
      ...BASE,
      app: 'cartera',
      kind: 'decision',
      issue: 'CAR-1',
      ...noteFb,
    })
    expect(r.status).toBe('similar_exists')
    if (r.status === 'similar_exists') {
      const cand = r.candidates[0]
      expect(cand.app).toBe('cartera')
      expect(cand.kind).toBe('regla')
      expect(cand.issue).toBeNull()
      expect(cand.same_issue).toBe(false)
      expect(cand.same_kind).toBe(false)
      expect(cand.matched_by).toBe('coseno')
      expect(cand.updated_at).toBeInstanceOf(Date)
    }
  })
})

// ─── Bloque 3: force + reason ─────────────────────────────────────────────────

describe('force con reason', () => {
  test('(i) force: true sin reason → ValidationError con field reason', async () => {
    const before = await prisma.note.count()
    let err: unknown
    try {
      await createNote(prisma, {
        ...BASE,
        kind: 'regla',
        ...noteA,
        force: true,
        // sin reason
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    if (err instanceof ValidationError) expect(err.field).toBe('reason')
    expect(await prisma.note.count()).toBe(before)
  })

  test('force: true con reason solo espacios → ValidationError con field reason', async () => {
    const before = await prisma.note.count()
    let err: unknown
    try {
      await createNote(prisma, {
        ...BASE,
        kind: 'regla',
        ...noteA,
        force: true,
        reason: '   ',
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    if (err instanceof ValidationError) expect(err.field).toBe('reason')
    expect(await prisma.note.count()).toBe(before)
  })

  test('(ii) force: true con reason válido → note.force_reason trimmed y persistido', async () => {
    const r = await createNote(prisma, {
      ...BASE,
      kind: 'regla',
      ...noteA,
      force: true,
      reason: '  es otra decisión, no un duplicado  ',
    })
    expect(r.status).toBe('created')
    if (r.status === 'created') {
      expect(r.note.force_reason).toBe('es otra decisión, no un duplicado')
      const read = await readNote(prisma, r.note.id)
      expect(read.force_reason).toBe('es otra decisión, no un duplicado')
    }
  })

  test('(iii) sin force, con reason → force_reason null', async () => {
    const r = await createNote(prisma, {
      ...BASE,
      kind: 'regla',
      ...noteA,
      reason: 'x',
    })
    expect(r.status).toBe('created')
    if (r.status === 'created') {
      expect(r.note.force_reason).toBeNull()
    }
  })
})
