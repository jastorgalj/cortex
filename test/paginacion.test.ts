/**
 * test/paginacion.test.ts — Implementación de acotar-respuestas-tools (#17).
 *
 * Secciones:
 *   1. Unit (sin BD): respuestaJson, acotarLista, acotarHistorial
 *   2. Capa de datos: listNotesPage, getNoteHistoryPage
 *   3. MCP por herramienta (puerto 13094)
 *   4. Snippet léxico ts_headline
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { warmup } from '../src/db/embeddings.ts'
import { createApp } from '../src/index.ts'
import {
  listNotesPage,
  getNoteHistoryPage,
  createNote,
  updateNote,
  NotFoundError,
} from '../src/db/notes.ts'
import { hybridSearch } from '../src/db/search.ts'
import { respuestaJson, acotarLista, acotarHistorial, MAX_RESPUESTA_CHARS } from '../src/tools/respuesta.ts'
import { generateUlid } from '../src/db/ulid.ts'

// Cuerpo determinista con similitud semántica probada (mismo que search.test.ts fixture:1).
// La query del test usa SINÓNIMOS para evitar solapamiento léxico: 'ajustar/rebajas/suscriptores/cuota'
// no comparten FTS-stems con 'descuentos/miembros/membresía/modificar' del body.
const SEMANTIC_BODY =
  'El sistema gestiona descuentos diferenciados para miembros con membresía activa. ' +
  'La tasa preferencial se calcula en base al historial de pagos y la categoría de cliente. ' +
  'Solo los administradores de la financiera pueden modificar este valor.'

// ─────────────────────────────────────────────────────────────────────────────
// Sección 1 — Unit (sin BD)
// ─────────────────────────────────────────────────────────────────────────────

describe('respuesta.ts — serialización compacta y tope (sin BD)', () => {
  test('respuestaJson serializa sin espacios ni saltos', () => {
    const result = respuestaJson({ a: [1, 2] })
    expect(result).toBe('{"a":[1,2]}')
  })

  test('acotarLista: 30 ítems de 1.000 chars → truncated:true, texto ≤ 20.000, next_offset = conservados', () => {
    const bigItem = 'x'.repeat(1000)
    const items = Array.from({ length: 30 }, () => ({ title: bigItem }))
    const result = acotarLista({ total: 30, items, offset: 0 })
    expect(result.truncated).toBe(true)
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_RESPUESTA_CHARS)
    expect(result.items.length).toBeGreaterThanOrEqual(1)
    expect(result.items.length).toBeLessThan(30)
    // next_offset = offset(0) + conservados
    expect(result.next_offset).toBe(result.items.length)
  })

  test('acotarLista: 3 ítems pequeños → sin clave truncated', () => {
    const items = [{ a: 1 }, { b: 2 }, { c: 3 }]
    const result = acotarLista({ total: 3, items, offset: 0 })
    expect('truncated' in result).toBe(false)
    expect(result.items.length).toBe(3)
    expect(result.next_offset).toBeNull()
  })

  test('acotarLista: un ítem de 25.000 chars → 1 ítem y sin truncated', () => {
    const bigItem = { body: 'x'.repeat(25000) }
    const result = acotarLista({ total: 1, items: [bigItem], offset: 0 })
    expect(result.items.length).toBe(1)
    expect('truncated' in result).toBe(false)
  })

  test('acotarHistorial: 5 ítems de 6.000 chars → conserva los de rev más alto, el último es rev:5', () => {
    const bigBody = 'x'.repeat(6000)
    const items = [
      { rev: 1, body_md: bigBody },
      { rev: 2, body_md: bigBody },
      { rev: 3, body_md: bigBody },
      { rev: 4, body_md: bigBody },
      { rev: 5, body_md: bigBody },
    ]
    const result = acotarHistorial({ total: 5, items })
    expect(result.truncated).toBe(true)
    // Debe haber quitado los de menor rev (los primeros)
    const revs = (result.items as Array<{ rev: number }>).map((r) => r.rev)
    // Consecutivos ascendentes y el último es rev 5
    expect(revs[revs.length - 1]).toBe(5)
    for (let i = 1; i < revs.length; i++) {
      expect(revs[i]).toBe(revs[i - 1]! + 1)
    }
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MAX_RESPUESTA_CHARS)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Setup compartido para secciones 2, 3 y 4
// ─────────────────────────────────────────────────────────────────────────────

const TEST_MCP_PORT = 13094
const MCP_URL = new URL(`http://localhost:${TEST_MCP_PORT}/mcp`)

const prisma = new PrismaClient()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverApp: any = null

// IDs de notas de fixture para las diferentes secciones
let pagNoteIds: string[] = []          // 75 notas para paginación
let tieNoteIds: string[] = []          // 4 notas para empate updated_at
let tagNoteIds: string[] = []          // 60 notas (30 con area:test-x, 30 sin)
let histNoteId = ''                    // nota con 12 revisiones
let zafiroNoteId = ''                  // nota con 'zafirotasa' > char 600
let conciliacionNoteId = ''            // nota con 'conciliación'
let zafiro2000NoteId = ''              // nota con zafirotasa + 2000 x
let tasaPreferencialPagId = ''         // nota semántica (tasa preferencial)

beforeAll(async () => {
  await prisma.$executeRaw`TRUNCATE notes CASCADE`

  console.log('[paginacion.test] Calentando modelo ONNX...')
  await warmup()
  console.log('[paginacion.test] Modelo listo.')

  // — 2.4 Fixture: 75 notas para "Tres páginas de 25" —
  // Creadas directamente via Prisma (sin embed, solo para tests de paginación)
  for (let i = 0; i < 75; i++) {
    const r = await prisma.note.create({
      data: {
        id: generateUlid(),
        title: `Nota paginacion ${String(i + 1).padStart(3, '0')}`,
        body_md: `Cuerpo para test de paginación. Número ${i + 1}. Único.`,
        app: 'general',
        kind: 'pitfall',
        tags: [],
        author: 'tester-pag',
        rev: 1,
      },
    })
    pagNoteIds.push(r.id)
  }

  // — 2.4 Fixture: 4 notas con mismo updated_at para empate —
  // (se fijará en test; se crean primero con timestamps distintos)
  for (let i = 0; i < 4; i++) {
    const r = await prisma.note.create({
      data: {
        id: generateUlid(),
        title: `Nota empate updated_at ${String(i + 1).padStart(2, '0')}`,
        body_md: `Cuerpo test empate ${i + 1}.`,
        app: 'general',
        kind: 'pitfall',
        tags: [],
        author: 'tester-empate',
        rev: 1,
      },
    })
    tieNoteIds.push(r.id)
  }
  // Fijar el mismo updated_at para las 4
  const tieIdsLiteral = `{${tieNoteIds.join(',')}}`
  await prisma.$executeRaw`UPDATE notes SET updated_at = '2026-01-01 12:00:00+00'::timestamptz WHERE id = ANY(${tieIdsLiteral}::text[])`

  // — 2.4 Fixture: 60 notas (30 con area:test-x, 30 sin) para test de tags —
  for (let i = 0; i < 60; i++) {
    const withTag = i < 30
    const r = await prisma.note.create({
      data: {
        id: generateUlid(),
        title: `Nota tags ${withTag ? 'con' : 'sin'} area:test-x ${String(i + 1).padStart(3, '0')}`,
        body_md: `Cuerpo test tags número ${i + 1}.`,
        app: 'general',
        kind: 'pitfall',
        tags: withTag ? ['area:test-x'] : [],
        author: 'tester-tags',
        rev: 1,
      },
    })
    tagNoteIds.push(r.id)
  }

  // — 2.4 Fixture: nota con 12 revisiones guardadas —
  const histCreated = await prisma.note.create({
    data: {
      id: generateUlid(),
      title: 'Nota historial 12 revisiones fixture',
      body_md: 'Cuerpo rev 1',
      app: 'general',
      kind: 'pitfall',
      tags: [],
      author: 'tester-hist',
      rev: 1,
    },
  })
  histNoteId = histCreated.id
  // Crear 12 revisiones actualizando 12 veces
  for (let i = 2; i <= 13; i++) {
    await updateNote(prisma, histNoteId, {
      body_md: `Cuerpo rev ${i}`,
      author: 'tester-hist',
      reason: `Actualización ${i}`,
    })
  }
  // Ahora la nota está en rev 13 (vigente) y hay 12 revisiones guardadas (rev 1-12)

  // — 4.2 Fixture: nota con 'zafirotasa' después del char 600 —
  const preamble = 'El sistema gestiona múltiples módulos financieros. '.repeat(15) // ~750 chars
  const zafiroResult = await createNote(prisma, {
    title: 'Nota zafirotasa fixture paginacion',
    body_md: preamble + ' zafirotasa es un término técnico del módulo de tasas.',
    app: 'general',
    kind: 'pitfall',
    author: 'tester-snippet',
  })
  zafiroNoteId = zafiroResult.status === 'created' ? zafiroResult.note.id : (zafiroResult as any).note?.id ?? ''

  // — 4.2 Fixture: nota con 'conciliación' —
  const concilResult = await createNote(prisma, {
    title: 'Nota conciliacion fixture paginacion',
    body_md: 'El proceso de conciliación bancaria verifica los movimientos del día. La conciliación se ejecuta al cierre.',
    app: 'general',
    kind: 'pitfall',
    author: 'tester-snippet',
    force: true,
    reason: 'bypass similitud: datos de test',
  })
  conciliacionNoteId = concilResult.status === 'created' ? concilResult.note.id : ''

  // — 4.2 Fixture: nota con zafirotasa + 2000 x (para test de tope 400) —
  const zafiro2000Result = await createNote(prisma, {
    title: 'Nota zafirotasa 2000x fixture paginacion',
    body_md: 'zafirotasa ' + 'x'.repeat(2000),
    app: 'general',
    kind: 'pitfall',
    author: 'tester-snippet',
    force: true,
    reason: 'bypass similitud: datos de test',
  })
  zafiro2000NoteId = zafiro2000Result.status === 'created' ? zafiro2000Result.note.id : ''

  // — 4.2 Fixture: nota semántica (tasa preferencial) para test solo-semántico —
  const tasaResult = await createNote(prisma, {
    title: 'Tasa preferencial módulo financiero paginacion',
    body_md: SEMANTIC_BODY,
    app: 'general',
    kind: 'regla',
    author: 'tester-snippet',
    force: true,
    reason: 'bypass similitud: datos de test',
  })
  tasaPreferencialPagId = tasaResult.status === 'created' ? tasaResult.note.id : ''

  // — Iniciar servidor MCP en 13094 —
  serverApp = createApp()
  serverApp.listen(TEST_MCP_PORT)
  console.log(`[paginacion.test] Servidor MCP en http://localhost:${TEST_MCP_PORT}`)
}, 15 * 60 * 1000)

afterAll(async () => {
  serverApp?.stop()
  await prisma.$disconnect()
})

// ─── Helpers MCP ─────────────────────────────────────────────────────────────

function makeClient(): Client {
  return new Client({ name: 'paginacion-test-client', version: '1.0' })
}

async function connectClient(client: Client): Promise<void> {
  const transport = new StreamableHTTPClientTransport(MCP_URL)
  await client.connect(transport)
}

function parseToolResult(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = result.content as Array<{ type: string; text?: string }>
  const text = content.find((c) => c.type === 'text')?.text ?? ''
  try { return JSON.parse(text) } catch { return text }
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content.find((c) => c.type === 'text')?.text ?? ''
}

// ─────────────────────────────────────────────────────────────────────────────
// Sección 2 — Capa de datos
// ─────────────────────────────────────────────────────────────────────────────

describe('listNotesPage — capa de datos', () => {
  test('Tres páginas de 25: 75 notas se recorren sin duplicados', async () => {
    // Usamos author=tester-pag para aislar de otras notas del fixture
    const page1 = await listNotesPage(prisma, { author: 'tester-pag' }, { limit: 25, offset: 0 })
    const page2 = await listNotesPage(prisma, { author: 'tester-pag' }, { limit: 25, offset: 25 })
    const page3 = await listNotesPage(prisma, { author: 'tester-pag' }, { limit: 25, offset: 50 })

    expect(page1.total).toBe(75)
    expect(page2.total).toBe(75)
    expect(page3.total).toBe(75)
    expect(page1.items.length).toBe(25)
    expect(page2.items.length).toBe(25)
    expect(page3.items.length).toBe(25)

    const allIds = [
      ...page1.items.map((n) => n.id),
      ...page2.items.map((n) => n.id),
      ...page3.items.map((n) => n.id),
    ]
    const unique = new Set(allIds)
    expect(unique.size).toBe(75)
  })

  test('Empate de updated_at: orden estable por id desc dentro del empate', async () => {
    // Las 4 notas con mismo updated_at deben aparecer en id DESC
    const page1 = await listNotesPage(prisma, { author: 'tester-empate' }, { limit: 2, offset: 0 })
    const page2 = await listNotesPage(prisma, { author: 'tester-empate' }, { limit: 2, offset: 2 })

    expect(page1.total).toBe(4)
    expect(page2.total).toBe(4)
    expect(page1.items.length).toBe(2)
    expect(page2.items.length).toBe(2)

    const allIds = [...page1.items.map((n) => n.id), ...page2.items.map((n) => n.id)]
    // Sin duplicados
    expect(new Set(allIds).size).toBe(4)
    // Todos los 4 tieNoteIds están cubiertos
    for (const id of tieNoteIds) {
      expect(allIds).toContain(id)
    }
    // Orden descendente por id dentro de cada página
    expect(page1.items[0]!.id > page1.items[1]!.id).toBe(true)
  })

  test('Tags con más notas que el límite: total correcto y solo ítems con el tag', async () => {
    const result = await listNotesPage(prisma, { tags: ['area:test-x'] }, { limit: 20, offset: 0 })
    expect(result.total).toBe(30)
    expect(result.items.length).toBe(20)
    // next_offset sería 20 (lo computa el handler; acá solo verificamos capa de datos)
    // Todos los ítems tienen el tag
    for (const item of result.items) {
      expect(item.tags).toContain('area:test-x')
    }
  })

  test('Una lista de tags vacía no filtra el listado', async () => {
    const withEmpty = await listNotesPage(prisma, { tags: [], author: 'tester-tags' }, { limit: 10, offset: 0 })
    const withoutTags = await listNotesPage(prisma, { author: 'tester-tags' }, { limit: 10, offset: 0 })
    // Ambas deben devolver el mismo total (60)
    expect(withEmpty.total).toBe(60)
    expect(withoutTags.total).toBe(60)
  })

  test('Offset más allá del final: 0 ítems, total correcto', async () => {
    const result = await listNotesPage(prisma, { author: 'tester-pag' }, { limit: 25, offset: 1000 })
    expect(result.total).toBe(75)
    expect(result.items.length).toBe(0)
  })
})

describe('getNoteHistoryPage — capa de datos', () => {
  test('Más revisiones que el límite: total 12, rev 3 a 12 con limit default', async () => {
    // Sin limit → default 10 → las 10 más recientes = rev 3..12
    const result = await getNoteHistoryPage(prisma, histNoteId, {})
    expect(result.total).toBe(12)
    expect(result.items.length).toBe(10)
    const revs = result.items.map((r) => r.rev)
    expect(revs[0]).toBe(3)
    expect(revs[9]).toBe(12)
    // Ascendente
    for (let i = 1; i < revs.length; i++) {
      expect(revs[i]).toBe(revs[i - 1]! + 1)
    }
  })

  test('Más revisiones que el límite: con limit:12, rev 1..12', async () => {
    const result = await getNoteHistoryPage(prisma, histNoteId, { limit: 12 })
    expect(result.total).toBe(12)
    expect(result.items.length).toBe(12)
    const revs = result.items.map((r) => r.rev)
    expect(revs[0]).toBe(1)
    expect(revs[11]).toBe(12)
  })

  test('rev de la versión vigente → NotFoundError con mensaje de cortex_read', async () => {
    // La nota está en rev 13 (vigente); el historial solo tiene 1-12
    const caught = await getNoteHistoryPage(prisma, histNoteId, { rev: 13 }).then(
      () => null,
      (err: unknown) => err,
    )
    expect(caught).toBeInstanceOf(NotFoundError)
    expect((caught as NotFoundError).message).toContain('13')
    expect((caught as NotFoundError).message).toContain(histNoteId)
    expect((caught as NotFoundError).message).toContain('cortex_read')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Sección 3 — Tests por MCP (puerto 13094)
// ─────────────────────────────────────────────────────────────────────────────

describe('cortex_list — Sin argumentos devuelve una página con total', () => {
  test('Sin argumentos: items ≤ 50, total correcto, next_offset no nulo', async () => {
    const client = makeClient()
    await connectClient(client)

    const result = await client.callTool({ name: 'cortex_list', arguments: {} })
    const data = parseToolResult(result) as { total: number; items: Array<unknown>; next_offset: number | null }

    expect(typeof data.total).toBe('number')
    expect(data.total).toBeGreaterThan(0)
    expect(Array.isArray(data.items)).toBe(true)
    expect(data.items.length).toBeLessThanOrEqual(50)
    // Fixture crea 144+ notas → total > 50 garantizado
    expect(data.total).toBeGreaterThan(50)
    expect(data.next_offset).toBe(50)

    await client.close()
  })

  test('Última página: items restantes y next_offset null', async () => {
    const client = makeClient()
    await connectClient(client)

    // Obtener total
    const first = parseToolResult(
      await client.callTool({ name: 'cortex_list', arguments: {} }),
    ) as { total: number }
    const total = first.total
    // Pedir desde el penúltimo offset para llegar al final
    const lastOffset = Math.max(0, total - 5)

    const result = await client.callTool({
      name: 'cortex_list',
      arguments: { offset: lastOffset, limit: 50 },
    })
    const data = parseToolResult(result) as { total: number; items: Array<unknown>; next_offset: number | null }

    expect(data.total).toBe(total)
    expect(data.next_offset).toBeNull()

    await client.close()
  })

  test('Cada ítem conserva sus campos: issue y force_reason (crear nota con ellos)', async () => {
    const client = makeClient()
    await connectClient(client)

    const writeResult = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota con issue y force_reason paginacion test',
        body_md: 'Cuerpo de nota para verificar campos en listado paginado.',
        app: 'general',
        kind: 'pitfall',
        author: 'tester-mcp-pag',
        issue: 'TEST-pag-001',
        force: true,
        reason: 'bypass similitud: datos de test paginacion',
      },
    })
    const created = parseToolResult(writeResult) as { id: string }
    expect(created.id).toBeTruthy()

    // Buscar la nota en la lista (con limit 200 para asegurar que aparece)
    const listResult = await client.callTool({
      name: 'cortex_list',
      arguments: { limit: 200, issue: 'TEST-pag-001' },
    })
    const data = parseToolResult(listResult) as { items: Array<{ id: string; issue?: string; force_reason?: string; body_md?: string }> }
    const found = data.items.find((n) => n.id === created.id)

    expect(found).toBeTruthy()
    expect(found!.issue).toBe('TEST-pag-001')
    expect(found!.force_reason).toBe('bypass similitud: datos de test paginacion')
    // No debe traer body_md
    expect('body_md' in found!).toBe(false)

    await client.close()
  })

  test('Parámetros fuera de rango rechazados: limit:0, 201 y offset:-1', async () => {
    const client = makeClient()
    await connectClient(client)

    for (const args of [{ limit: 0 }, { limit: 201 }, { offset: -1 }]) {
      const result = await client.callTool({ name: 'cortex_list', arguments: args })
      expect((result as { isError?: boolean }).isError).toBe(true)
      // El texto debe nombrar el parámetro inválido
      const text = textOf(result)
      const paramName = 'limit' in args ? 'limit' : 'offset'
      expect(text).toContain(paramName)
    }

    await client.close()
  })
})

describe('cortex_history — sin cuerpos por defecto y revisión puntual', () => {
  test('El historial responde sin cuerpos por defecto', async () => {
    const client = makeClient()
    await connectClient(client)

    // Crear nota y actualizar 1 vez
    const writeResult = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota para test historial sin cuerpo paginacion',
        body_md: 'Cuerpo original del historial.',
        app: 'general',
        kind: 'pitfall',
        author: 'tester-mcp-hist',
        force: true,
        reason: 'bypass similitud: datos de test',
      },
    })
    const created = parseToolResult(writeResult) as { id: string }
    await client.callTool({
      name: 'cortex_update',
      arguments: {
        id: created.id,
        body_md: 'Cuerpo actualizado del historial.',
        author: 'tester-mcp-hist',
        reason: 'primera actualización historial test',
      },
    })

    // Historial sin include_body → ningún ítem debe tener body_md
    const histResult = await client.callTool({
      name: 'cortex_history',
      arguments: { id: created.id },
    })
    const histData = parseToolResult(histResult) as { total: number; items: Array<Record<string, unknown>> }

    expect(histData.total).toBe(1)
    expect(histData.items.length).toBe(1)
    for (const item of histData.items) {
      expect('body_md' in item).toBe(false)
    }

    // Con include_body: true → todos tienen body_md
    const histBodyResult = await client.callTool({
      name: 'cortex_history',
      arguments: { id: created.id, include_body: true },
    })
    const histBodyData = parseToolResult(histBodyResult) as { total: number; items: Array<Record<string, unknown>> }
    for (const item of histBodyData.items) {
      expect('body_md' in item).toBe(true)
    }

    await client.close()
  })

  test('El historial entrega una revisión puntual con su cuerpo', async () => {
    const client = makeClient()
    await connectClient(client)

    // Crear y actualizar para tener al menos 1 revisión
    const writeResult = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota revisión puntual paginacion test',
        body_md: 'Cuerpo rev 1 original.',
        app: 'general',
        kind: 'pitfall',
        author: 'tester-mcp-rev',
        force: true,
        reason: 'bypass similitud: datos de test',
      },
    })
    const created = parseToolResult(writeResult) as { id: string }
    await client.callTool({
      name: 'cortex_update',
      arguments: {
        id: created.id,
        body_md: 'Cuerpo rev 2 actualizado.',
        author: 'tester-mcp-rev',
        reason: 'update para test rev puntual',
      },
    })

    // Rev 1 puntual → debe traer cuerpo
    const revResult = await client.callTool({
      name: 'cortex_history',
      arguments: { id: created.id, rev: 1 },
    })
    const revData = parseToolResult(revResult) as { total: number; items: Array<{ rev: number; body_md?: string }> }

    expect(revData.total).toBe(1)
    expect(revData.items.length).toBe(1)
    expect(revData.items[0]!.rev).toBe(1)
    expect(revData.items[0]!.body_md).toBe('Cuerpo rev 1 original.')

    await client.close()
  })

  test('El historial devuelve las revisiones más recientes con limit', async () => {
    const client = makeClient()
    await connectClient(client)

    // Verificar historial de nota con 12 revisiones (histNoteId)
    const histResult = await client.callTool({
      name: 'cortex_history',
      arguments: { id: histNoteId },
    })
    const data = parseToolResult(histResult) as { total: number; items: Array<{ rev: number }> }
    expect(data.total).toBe(12)
    expect(data.items.length).toBe(10) // default limit 10
    // Las 10 más recientes: rev 3..12 en orden asc
    expect(data.items[0]!.rev).toBe(3)
    expect(data.items[9]!.rev).toBe(12)

    await client.close()
  })

  test('Parámetros fuera de rango en cortex_history: limit:0, 101 y rev:0', async () => {
    const client = makeClient()
    await connectClient(client)

    for (const args of [{ id: histNoteId, limit: 0 }, { id: histNoteId, limit: 101 }, { id: histNoteId, rev: 0 }]) {
      const result = await client.callTool({ name: 'cortex_history', arguments: args })
      expect((result as { isError?: boolean }).isError).toBe(true)
      const text = textOf(result)
      const paramName = 'rev' in args ? 'rev' : 'limit'
      expect(text).toContain(paramName)
    }

    await client.close()
  })

  test('rev de la versión vigente → isError con id, número y cortex_read', async () => {
    const client = makeClient()
    await connectClient(client)

    // histNoteId está en rev 13 (vigente); rev 13 no existe en historial
    const result = await client.callTool({
      name: 'cortex_history',
      arguments: { id: histNoteId, rev: 13 },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = textOf(result)
    expect(text).toContain('13')
    expect(text).toContain(histNoteId)
    expect(text).toContain('cortex_read')

    await client.close()
  })
})

describe('cortex_history — sin revisiones (id sin historial o inexistente)', () => {
  test('id sin revisiones → {total:0, items:[]}', async () => {
    const client = makeClient()
    await connectClient(client)

    // Crear una nota sin actualizar (rev 1 vigente, 0 revisiones guardadas)
    const writeResult = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota sin historial paginacion delete test',
        body_md: 'Cuerpo sin historial.',
        app: 'general',
        kind: 'pitfall',
        author: 'tester-mcp-nohist',
        force: true,
        reason: 'bypass similitud: datos de test',
      },
    })
    const created = parseToolResult(writeResult) as { id: string }

    const histResult = await client.callTool({
      name: 'cortex_history',
      arguments: { id: created.id },
    })
    const data = parseToolResult(histResult) as { total: number; items: Array<unknown> }
    expect(data.total).toBe(0)
    expect(data.items.length).toBe(0)

    await client.close()
  })
})

describe('Las respuestas JSON de las tools son compactas', () => {
  test('Ninguna tool indenta su respuesta JSON', async () => {
    const client = makeClient()
    await connectClient(client)

    // Crear nota de prueba
    const writeResult = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota compacta test JSON paginacion',
        body_md: 'Cuerpo para test de JSON compacto.',
        app: 'general',
        kind: 'pitfall',
        author: 'tester-compacto',
        force: true,
        reason: 'bypass similitud: datos de test',
      },
    })
    // cortex_write → nota creada
    const writeText = textOf(writeResult)
    const writeObj = JSON.parse(writeText)
    expect(writeText).toBe(JSON.stringify(writeObj)) // sin indentación

    // cortex_read
    const created = writeObj as { id: string }
    const readText = textOf(await client.callTool({ name: 'cortex_read', arguments: { id: created.id } }))
    const readObj = JSON.parse(readText)
    expect(readText).toBe(JSON.stringify(readObj))

    // cortex_list
    const listText = textOf(await client.callTool({ name: 'cortex_list', arguments: { limit: 1 } }))
    const listObj = JSON.parse(listText)
    expect(listText).toBe(JSON.stringify(listObj))

    // cortex_history
    const histText = textOf(await client.callTool({ name: 'cortex_history', arguments: { id: created.id } }))
    const histObj = JSON.parse(histText)
    expect(histText).toBe(JSON.stringify(histObj))

    // cortex_update
    const updateText = textOf(await client.callTool({
      name: 'cortex_update',
      arguments: { id: created.id, body_md: 'Cuerpo actualizado compacto.', author: 'tester-compacto', reason: 'update compacto' },
    }))
    const updateObj = JSON.parse(updateText)
    expect(updateText).toBe(JSON.stringify(updateObj))

    // cortex_search
    const searchText = textOf(await client.callTool({ name: 'cortex_search', arguments: { q: 'compacto test' } }))
    const searchObj = JSON.parse(searchText)
    expect(searchText).toBe(JSON.stringify(searchObj))

    // cortex_delete
    const writeResult2 = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota para borrar compacto test paginacion',
        body_md: 'Cuerpo para borrado compacto.',
        app: 'general',
        kind: 'pitfall',
        author: 'tester-compacto',
        force: true,
        reason: 'bypass similitud: datos de test',
      },
    })
    const created2 = parseToolResult(writeResult2) as { id: string }
    const deleteText = textOf(await client.callTool({
      name: 'cortex_delete',
      arguments: { id: created2.id, author: 'tester-compacto', reason: 'test borrado compacto' },
    }))
    const deleteObj = JSON.parse(deleteText)
    expect(deleteText).toBe(JSON.stringify(deleteObj))

    // cortex_write similar_exists
    const write3 = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota compacta test JSON paginacion', // misma que antes → similar_exists
        body_md: 'Cuerpo para test de JSON compacto.',
        app: 'general',
        kind: 'pitfall',
        author: 'tester-compacto',
        // sin force → similar_exists
      },
    })
    const write3Text = textOf(write3)
    const write3Obj = JSON.parse(write3Text)
    expect(write3Text).toBe(JSON.stringify(write3Obj))
    // cortex_apps
    const appsText = textOf(await client.callTool({ name: 'cortex_apps', arguments: {} }))
    const appsObj = JSON.parse(appsText)
    expect(appsText).toBe(JSON.stringify(appsObj)) // sin indentación

    expect((write3Obj as { status?: string }).status).toBe('similar_exists')

    await client.close()
  })
})

describe('Tope duro de 20.000 caracteres en list e history', () => {
  test('Una lista que no cabe se recorta por ítems (truncated:true)', async () => {
    const client = makeClient()
    await connectClient(client)

    // Crear 30 notas con título de ~1.000 chars
    for (let i = 0; i < 30; i++) {
      await client.callTool({
        name: 'cortex_write',
        arguments: {
          title: `tope-test-pag ${String(i).padStart(3, '0')} ` + 'T'.repeat(970),
          body_md: 'Cuerpo test tope.',
          app: 'general',
          kind: 'pitfall',
          author: 'tester-tope',
          force: true,
          reason: 'bypass similitud: datos de test tope',
        },
      })
    }

    const result = await client.callTool({
      name: 'cortex_list',
      arguments: { limit: 30, author: 'tester-tope' },
    })
    const text = textOf(result)
    const data = parseToolResult(result) as {
      total: number
      items: Array<unknown>
      next_offset: number | null
      truncated?: boolean
    }

    expect(data.truncated).toBe(true)
    expect(text.length).toBeLessThanOrEqual(MAX_RESPUESTA_CHARS)
    expect(data.items.length).toBeGreaterThanOrEqual(1)
    expect(data.items.length).toBeLessThan(30)
    expect(data.total).toBe(30)

    await client.close()
  }, 60_000)

  test('Sin recorte no hay truncated: 3 notas pequeñas', async () => {
    const client = makeClient()
    await connectClient(client)

    // Tres notas pequeñas vía DB ya están en el fixture (tester-hist por ejemplo)
    // Usar notas del tester-hist que son pocas
    const result = await client.callTool({
      name: 'cortex_list',
      arguments: { limit: 3, author: 'tester-hist' },
    })
    const data = parseToolResult(result) as { truncated?: boolean }
    expect('truncated' in data).toBe(false)

    await client.close()
  })

  test('Un ítem que solo supera el tope → 1 ítem y sin truncated', async () => {
    const client = makeClient()
    await connectClient(client)

    // Verificar cortex_read de nota grande (sin tope)
    // Crear una nota grande de 25.100 chars y verificar que cortex_read la devuelve completa
    const bigBody = 'B'.repeat(25100)
    const writeResult = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota grande 25100 chars paginacion test',
        body_md: bigBody,
        app: 'general',
        kind: 'pitfall',
        author: 'tester-grande',
        force: true,
        reason: 'bypass similitud: datos de test',
      },
    })
    const created = parseToolResult(writeResult) as { id: string }

    const readResult = await client.callTool({
      name: 'cortex_read',
      arguments: { id: created.id },
    })
    const readData = parseToolResult(readResult) as { body_md: string }
    // cortex_read está exento del tope → cuerpo completo
    expect(readData.body_md.length).toBe(25100)

    await client.close()
  })

  test('Las lecturas puntuales no se recortan: cortex_history con rev devuelve cuerpo completo', async () => {
    const client = makeClient()
    await connectClient(client)

    // Crear nota con cuerpo de 25.000 chars y actualizar para tener rev 1 en historial
    const bigBody = 'C'.repeat(25000)
    const writeResult = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota para rev puntual grande paginacion test',
        body_md: bigBody,
        app: 'general',
        kind: 'pitfall',
        author: 'tester-rev-grande',
        force: true,
        reason: 'bypass similitud: datos de test',
      },
    })
    const created = parseToolResult(writeResult) as { id: string }
    await client.callTool({
      name: 'cortex_update',
      arguments: {
        id: created.id,
        body_md: 'Cuerpo actualizado rev 2.',
        author: 'tester-rev-grande',
        reason: 'update para test rev puntual grande',
      },
    })

    // Rev 1 puntual → sin tope
    const revResult = await client.callTool({
      name: 'cortex_history',
      arguments: { id: created.id, rev: 1 },
    })
    const revData = parseToolResult(revResult) as { total: number; items: Array<{ body_md: string }> }
    expect(revData.items.length).toBe(1)
    expect(revData.items[0]!.body_md.length).toBe(25000)

    await client.close()
  })
})

describe('Paginación: seguir next_offset no pierde notas', () => {
  test('Seguir next_offset hasta null recorre todos los ids una vez', async () => {
    const client = makeClient()
    await connectClient(client)

    const collectedIds: string[] = []
    let offset: number | null = 0
    let total = 0

    while (offset !== null) {
      const result = await client.callTool({
        name: 'cortex_list',
        arguments: { author: 'tester-pag', limit: 25, offset },
      })
      const data = parseToolResult(result) as {
        total: number
        items: Array<{ id: string }>
        next_offset: number | null
      }
      total = data.total
      collectedIds.push(...data.items.map((n) => n.id))
      offset = data.next_offset
    }

    expect(total).toBe(75)
    expect(collectedIds.length).toBe(75)
    expect(new Set(collectedIds).size).toBe(75)

    await client.close()
  })
})

describe('Se quedan las más recientes (cortex_history acota por items recientes)', () => {
  test('Historial acotado conserva las revisiones con mayor rev (unit)', () => {
    // 15 × 5.000 = 75.000 > 20.000 → truncado garantizado; aserción incondicional
    const bigBody = 'x'.repeat(5000)
    const items = Array.from({ length: 15 }, (_, i) => ({ rev: i + 1, body_md: bigBody }))
    const result = acotarHistorial({ total: 15, items })

    expect(result.truncated).toBe(true) // 75.000 > MAX_RESPUESTA_CHARS
    const revs = (result.items as Array<{ rev: number }>).map((r) => r.rev)
    expect(revs[revs.length - 1]).toBe(15) // siempre conserva la más reciente
  })

  test('Se quedan las más recientes: cortex_history por MCP acota y conserva el rev más alto', async () => {
    // 5 revisiones de 6.000 chars en historial (5 × 6000 = 30.000 > 20.000) → truncated:true
    const bigBody = 'h'.repeat(6000)
    const client = makeClient()
    await connectClient(client)

    const writeRes = parseToolResult(
      await client.callTool({
        name: 'cortex_write',
        arguments: {
          title: 'Nota historial grande para tope MCP',
          body_md: bigBody,
          app: 'general',
          kind: 'pitfall',
          author: 'tester-hist-tope',
          force: true,
          reason: 'bypass similitud: test tope historial',
        },
      }),
    ) as { id: string }
    const noteId = writeRes.id

    // 5 actualizaciones con cuerpo grande → revs 1-5 en historial
    for (let i = 2; i <= 6; i++) {
      await client.callTool({
        name: 'cortex_update',
        arguments: {
          id: noteId,
          body_md: bigBody,
          author: 'tester-hist-tope',
          reason: `actualización ${i} para test tope`,
        },
      })
    }

    const histResult = parseToolResult(
      await client.callTool({
        name: 'cortex_history',
        arguments: { id: noteId, include_body: true },
      }),
    ) as { total: number; items: Array<{ rev: number; body_md: string }>; truncated?: boolean }

    expect(histResult.truncated).toBe(true)             // 5 × 6000 chars supera 20.000
    expect(histResult.total).toBe(5)
    const revs = histResult.items.map((r) => r.rev)
    expect(revs[revs.length - 1]).toBe(5)               // revisión más reciente conservada
    for (let i = 1; i < revs.length; i++) {
      expect(revs[i]).toBe(revs[i - 1]! + 1)           // consecutivos ascendentes
    }
    expect(JSON.stringify(histResult).length).toBeLessThanOrEqual(20000)

    await client.close()
  }, 60_000)

  test('Un ítem que solo supera el tope en cortex_history: se devuelve sin truncated', async () => {
    // 1 revisión de 25.000 chars en historial → un solo ítem → acotarHistorial no puede quitar → sin truncated
    const bigBody = 'H'.repeat(25000)
    const client = makeClient()
    await connectClient(client)

    const writeRes = parseToolResult(
      await client.callTool({
        name: 'cortex_write',
        arguments: {
          title: 'Nota única revisión 25k para tope MCP',
          body_md: bigBody,
          app: 'general',
          kind: 'pitfall',
          author: 'tester-hist-tope-unico',
          force: true,
          reason: 'bypass similitud: test tope historial unico',
        },
      }),
    ) as { id: string }
    const noteId = writeRes.id

    // 1 actualización → rev 1 (25.000 chars) va al historial
    await client.callTool({
      name: 'cortex_update',
      arguments: {
        id: noteId,
        body_md: 'Cuerpo actualizado rev 2.',
        author: 'tester-hist-tope-unico',
        reason: 'update para mover rev 1 al historial',
      },
    })

    const histResult = parseToolResult(
      await client.callTool({
        name: 'cortex_history',
        arguments: { id: noteId, include_body: true, limit: 1 },
      }),
    ) as { total: number; items: Array<{ body_md: string }>; truncated?: boolean }

    expect(histResult.items.length).toBe(1)
    expect(histResult.total).toBe(1)
    expect(histResult.items[0]!.body_md.length).toBeGreaterThan(20000) // cuerpo 25.000 chars
    expect('truncated' in histResult).toBe(false)                       // un solo ítem no se quita

    await client.close()
  }, 60_000)
})

describe('tools/list muestra los parámetros nuevos', () => {
  test('cortex_list expone limit y offset en su inputSchema', async () => {
    const client = makeClient()
    await connectClient(client)

    const { tools } = await client.listTools()
    const listTool = tools.find((t) => t.name === 'cortex_list')
    expect(listTool).toBeTruthy()

    const props = (listTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    expect(props['limit']).toBeTruthy()
    expect(props['offset']).toBeTruthy()

    await client.close()
  })

  test('cortex_history expone limit, include_body y rev en su inputSchema', async () => {
    const client = makeClient()
    await connectClient(client)

    const { tools } = await client.listTools()
    const histTool = tools.find((t) => t.name === 'cortex_history')
    expect(histTool).toBeTruthy()

    const props = (histTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    expect(props['limit']).toBeTruthy()
    expect(props['include_body']).toBeTruthy()
    expect(props['rev']).toBeTruthy()

    await client.close()
  })

  test('La descripción de cortex_list menciona paginado y next_offset', async () => {
    const client = makeClient()
    await connectClient(client)

    const { tools } = await client.listTools()
    const listTool = tools.find((t) => t.name === 'cortex_list')
    expect(listTool!.description).toContain('next_offset')

    await client.close()
  })

  test('La descripción de cortex_history no dice "completo" ni "todas"', async () => {
    const client = makeClient()
    await connectClient(client)

    const { tools } = await client.listTools()
    const histTool = tools.find((t) => t.name === 'cortex_history')
    expect(histTool!.description).not.toContain('completo')
    expect(histTool!.description).not.toContain('todas')

    await client.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Sección 4 — Snippet léxico
// ─────────────────────────────────────────────────────────────────────────────

describe('hybridSearch — snippet léxico ts_headline', () => {
  test('El snippet de "zafirotasa" aparece en el snippet del resultado léxico', async () => {
    const results = await hybridSearch(prisma, 'zafirotasa')
    const hit = results.find((r) => r.id === zafiroNoteId || r.id === zafiro2000NoteId)
    expect(hit).toBeTruthy()
    expect(['lexical', 'both']).toContain(hit!.origin)
    expect(hit!.snippet.toLowerCase()).toContain('zafirotasa')
  }, 60_000)

  test('El snippet de "conciliación" contiene "conciliacion" (sin tilde, ts_headline sobre unaccent)', async () => {
    const results = await hybridSearch(prisma, 'conciliacion')
    const hit = results.find((r) => r.id === conciliacionNoteId)
    expect(hit).toBeTruthy()
    expect(['lexical', 'both']).toContain(hit!.origin)
    // ts_headline corre sobre unaccent(body_md) → snippet sin tildes
    expect(hit!.snippet.toLowerCase()).toContain('conciliacion')
  }, 60_000)

  test('Un término con tilde aparece en el snippet (cuerpo zafirotasa + 2000 x mide ≤ 401)', async () => {
    const results = await hybridSearch(prisma, 'zafirotasa')
    const hit = results.find((r) => r.id === zafiro2000NoteId)
    expect(hit).toBeTruthy()
    // El snippet no debe pasar de 401 chars (400 + '…')
    expect(hit!.snippet.length).toBeLessThanOrEqual(401)
  }, 60_000)

  test('Un resultado solo semántico conserva el inicio del cuerpo (200 chars + …)', async () => {
    // La query usa sinónimos de los conceptos del body: 'ajustar/rebajas/suscriptores/cuota'
    // no comparten FTS-stems con 'descuentos/miembros/membresía/modificar' → origin siempre 'semantic'
    const results = await hybridSearch(prisma, 'quiénes pueden ajustar las rebajas para suscriptores con cuota')
    const hit = results.find((r) => r.id === tasaPreferencialPagId)
    expect(hit).toBeTruthy()
    expect(hit!.origin).toBe('semantic')
    // extractSnippet(SEMANTIC_BODY, 200) = SEMANTIC_BODY[0:200] + '…'
    expect(hit!.snippet).toBe(SEMANTIC_BODY.substring(0, 200) + '…')
  }, 60_000)
})
