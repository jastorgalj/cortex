/**
 * test/mcp.test.ts — Task 3.1: MCP server de integración.
 *
 * Verifica:
 * - tools/list devuelve exactamente las seis tools nombradas
 * - Ciclo write→search→read→update→history funciona de punta a punta por MCP real
 *
 * Usa Client + StreamableHTTPClientTransport del SDK oficial.
 * El servidor Elysia arranca en proceso antes de los tests.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { warmup } from '../src/db/embeddings.ts'
import { readFileSync } from 'node:fs'

/** Versión declarada en package.json: la misma que anuncia el servidor. */
const pkgVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string }
).version
import { createApp } from '../src/index.ts'
import { NOTE_KINDS, NOTE_KIND_DESCRIPTIONS } from '../src/db/constants.ts'

const TEST_PORT = 13091
const BASE_URL = `http://localhost:${TEST_PORT}`
const MCP_URL = new URL(`${BASE_URL}/mcp`)

const prisma = new PrismaClient()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverApp: any = null

beforeAll(async () => {
  // Limpia datos de tests anteriores
  await prisma.$executeRaw`TRUNCATE notes CASCADE`

  // Warmup del modelo (obligatorio antes de registrar tools que llaman embed())
  console.log('[mcp.test] Calentando modelo ONNX...')
  await warmup()
  console.log('[mcp.test] Modelo listo.')

  // Arranca el servidor Elysia en proceso
  serverApp = createApp()
  serverApp.listen(TEST_PORT)
  console.log(`[mcp.test] Servidor escuchando en ${BASE_URL}`)
}, 15 * 60 * 1000) // 15 min — cubre primera descarga del modelo

afterAll(async () => {
  serverApp?.stop()
  await prisma.$disconnect()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClient(): Client {
  return new Client({ name: 'mcp-test-client', version: '1.0' })
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

type KindProperty = { type?: string; enum?: string[]; description?: string }

function kindProperty(inputSchema: unknown): KindProperty {
  const props = (inputSchema as { properties?: Record<string, KindProperty> }).properties ?? {}
  const prop = props['kind']
  if (!prop) throw new Error('el schema de la tool no declara la propiedad kind')
  return prop
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MCP server — cortex tools', () => {
  test('tools/list devuelve exactamente las ocho tools nombradas (todas con prefijo cortex_)', async () => {
    const client = makeClient()
    await connectClient(client)

    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()

    expect(names).toEqual([
      'cortex_apps',
      'cortex_delete',
      'cortex_history',
      'cortex_list',
      'cortex_read',
      'cortex_search',
      'cortex_update',
      'cortex_write',
    ])

    // Verifica que cada tool tenga description y inputSchema
    for (const tool of tools) {
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeTruthy()
    }

    // Verifica que todos los nombres empiezan con cortex_ (no con el prefijo antiguo)
    for (const name of names) {
      expect(name).toMatch(/^cortex_/)
    }

    await client.close()
  })

  test('initialize responde serverInfo.name=cortex y la version de package.json', async () => {
    const client = makeClient()
    const transport = new StreamableHTTPClientTransport(MCP_URL)
    await client.connect(transport)
    const serverInfo = client.getServerVersion()
    expect(serverInfo?.name).toBe('cortex')
    // La versión no se fija a mano: se compara contra package.json, que es lo que
    // lee el servidor. Un literal acá vuelve a esconder el día que la versión sube.
    expect(serverInfo?.version).toBe(pkgVersion)
    await client.close()
  })

  test('write→search→read→update→history funciona de punta a punta', async () => {
    const client = makeClient()
    await connectClient(client)

    // 1. cortex_write — crea una nota
    const writeResult = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Flujo de aprobación de crédito hipotecario en Cartera',
        body_md:
          'El flujo de aprobación hipotecaria requiere validación del central de riesgo, cálculo de tasa UF y confirmación del ejecutivo de riesgo.',
        app: 'cartera',
        kind: 'flujo',
        tags: ['hipotecario', 'test-mcp'],
        author: 'mcp-test',
      },
    })

    const writeData = parseToolResult(writeResult) as { id: string; title: string; rev: number }
    expect(writeData.id).toBeTruthy()
    expect(writeData.id.length).toBe(26) // ULID
    expect(writeData.rev).toBe(1)
    const noteId = writeData.id

    // 2. cortex_search — busca el contenido recién creado
    const searchResult = await client.callTool({
      name: 'cortex_search',
      arguments: {
        q: 'flujo aprobacion hipotecaria',
        app: 'cartera',
        limit: 5,
      },
    })
    const searchData = parseToolResult(searchResult) as Array<{ id: string }>
    const ids = searchData.map((r) => r.id)
    expect(ids).toContain(noteId)

    // 3. cortex_read — lee la nota por id
    const readResult = await client.callTool({
      name: 'cortex_read',
      arguments: { id: noteId },
    })
    const readData = parseToolResult(readResult) as { id: string; rev: number; title: string }
    expect(readData.id).toBe(noteId)
    expect(readData.rev).toBe(1)

    // 4. cortex_update — actualiza con motivo
    const updateResult = await client.callTool({
      name: 'cortex_update',
      arguments: {
        id: noteId,
        body_md:
          'El flujo hipotecario actualizado: validación BC, cálculo UF, confirmación de riesgo y aprobación del gerente de crédito.',
        author: 'mcp-test',
        reason: 'Agrego paso del gerente de crédito',
        base_rev: 1,
      },
    })
    const updateData = parseToolResult(updateResult) as { rev: number }
    expect(updateData.rev).toBe(2)

    // 5. cortex_history — verifica que hay 1 revisión (la anterior a la actualización)
    const histResult = await client.callTool({
      name: 'cortex_history',
      arguments: { id: noteId },
    })
    const histData = parseToolResult(histResult) as Array<{ rev: number; reason?: string }>
    expect(histData.length).toBe(1)
    expect(histData[0]!.rev).toBe(1)
    expect(histData[0]!.reason).toBe('Agrego paso del gerente de crédito')

    await client.close()
  })

  test('cortex_write sin author devuelve error descriptivo', async () => {
    const client = makeClient()
    await connectClient(client)

    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota sin autor',
        body_md: 'Contenido',
        app: 'general',
        kind: 'pitfall',
        author: '',
      },
    })

    const content180 = result.content as Array<{ type: string; text?: string }>
    const text = content180.find((c) => c.type === 'text')?.text ?? ''
    expect(text).toContain('author')
    expect((result as { isError?: boolean }).isError).toBe(true)

    await client.close()
  })

  test('cortex_read de id inexistente devuelve error descriptivo', async () => {
    const client = makeClient()
    await connectClient(client)

    const result = await client.callTool({
      name: 'cortex_read',
      arguments: { id: '01JZZZZZZZZZZZZZZZZZZZZZZZ' },
    })

    const content196 = result.content as Array<{ type: string; text?: string }>
    const text196 = content196.find((c) => c.type === 'text')?.text ?? ''
    expect(text196).toContain('no encontrada')
    expect((result as { isError?: boolean }).isError).toBe(true)

    await client.close()
  })

  test('cortex_list sin filtros devuelve notas existentes', async () => {
    const client = makeClient()
    await connectClient(client)

    const result = await client.callTool({
      name: 'cortex_list',
      arguments: {},
    })

    const data = parseToolResult(result) as Array<{ id: string }>
    expect(Array.isArray(data)).toBe(true)
    // Debe haber al menos la nota del ciclo completo
    expect(data.length).toBeGreaterThanOrEqual(1)

    await client.close()
  })

  test('el schema del campo kind deriva de NOTE_KINDS y describe el significado de cada tipo', async () => {
    const client = makeClient()
    await connectClient(client)

    const { tools } = await client.listTools()

    // Las cuatro tools que exponen `kind` lo derivan de la misma constante: mismo enum exacto
    for (const name of ['cortex_search', 'cortex_write', 'cortex_list', 'cortex_update']) {
      const tool = tools.find((t) => t.name === name)
      expect(tool).toBeTruthy()
      const kind = kindProperty(tool!.inputSchema)
      expect(kind.enum).toEqual([...NOTE_KINDS])
      expect(kind.description).toBeTruthy()
      // El significado de cada tipo sale de NOTE_KIND_DESCRIPTIONS
      for (const valid of NOTE_KINDS) {
        expect(kind.description).toContain(NOTE_KIND_DESCRIPTIONS[valid])
      }
      expect(kind.description).not.toContain('otro')
    }

    await client.close()
  })

  test("cortex_write con kind 'otro' responde error que nombra los cinco válidos y no crea la nota", async () => {
    const client = makeClient()
    await connectClient(client)

    const before = parseToolResult(
      await client.callTool({ name: 'cortex_list', arguments: {} }),
    ) as Array<{ id: string }>

    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota clasificada con el tipo retirado',
        body_md: 'Este cuerpo válido intenta declararse con el tipo «otro», que ya no existe en el enum.',
        app: 'general',
        kind: 'otro',
        author: 'mcp-test',
        force: true,
        reason: 'bypass similitud: datos de test',
      },
    })

    const text = textOf(result)
    expect((result as { isError?: boolean }).isError).toBe(true)
    // El mensaje nombra los cinco tipos válidos
    for (const valid of NOTE_KINDS) {
      expect(text).toContain(valid)
    }

    // No se creó ninguna nota
    const after = parseToolResult(
      await client.callTool({ name: 'cortex_list', arguments: {} }),
    ) as Array<{ id: string }>
    expect(after.length).toBe(before.length)

    await client.close()
  })

  test('cortex_update corrige kind y app, y rechaza clasificaciones inválidas', async () => {
    const client = makeClient()
    await connectClient(client)

    const writeResult = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: `Nota mal clasificada que hay que reclasificar ${Date.now()}`,
        body_md:
          'El job nocturno de conciliación bancaria falla si el archivo del banco llega con el campo de monto en formato local en vez de punto decimal.',
        app: 'cartera',
        kind: 'pitfall',
        author: 'mcp-test',
        force: true,
        reason: 'bypass similitud: datos de test',
      },
    })
    const created = parseToolResult(writeResult) as { id: string; rev: number; kind: string }
    expect(created.kind).toBe('pitfall')
    expect(created.rev).toBe(1)

    // kind inválido → rechazo, la nota no cambia
    const badKind = await client.callTool({
      name: 'cortex_update',
      arguments: { id: created.id, kind: 'otro', author: 'mcp-test' },
    })
    expect((badKind as { isError?: boolean }).isError).toBe(true)
    for (const valid of NOTE_KINDS) {
      expect(textOf(badKind)).toContain(valid)
    }

    // app vacío → rechazo del dominio, nombrando el campo
    const badApp = await client.callTool({
      name: 'cortex_update',
      arguments: { id: created.id, app: '   ', author: 'mcp-test' },
    })
    expect((badApp as { isError?: boolean }).isError).toBe(true)
    expect(textOf(badApp)).toContain('app')

    const unchanged = parseToolResult(
      await client.callTool({ name: 'cortex_read', arguments: { id: created.id } }),
    ) as { kind: string; app: string; rev: number }
    expect(unchanged.kind).toBe('pitfall')
    expect(unchanged.app).toBe('cartera')
    expect(unchanged.rev).toBe(1)

    // Con valores válidos cambia la clasificación y avanza la revisión
    const updateResult = await client.callTool({
      name: 'cortex_update',
      arguments: {
        id: created.id,
        kind: 'regla',
        app: 'general',
        author: 'mcp-test',
        reason: 'reclasificada por el agente',
        base_rev: 1,
      },
    })
    const updated = parseToolResult(updateResult) as { kind: string; app: string; rev: number }
    expect(updated.kind).toBe('regla')
    expect(updated.app).toBe('general')
    expect(updated.rev).toBe(2)

    // El historial conserva la revisión 1
    const history = parseToolResult(
      await client.callTool({ name: 'cortex_history', arguments: { id: created.id } }),
    ) as Array<{ rev: number; reason?: string }>
    expect(history.length).toBe(1)
    expect(history[0]!.rev).toBe(1)
    expect(history[0]!.reason).toBe('reclasificada por el agente')

    // base_rev obsoleto sigue detectando el conflicto después de la corrección
    const conflict = await client.callTool({
      name: 'cortex_update',
      arguments: { id: created.id, kind: 'decision', author: 'mcp-test', base_rev: 1 },
    })
    expect((conflict as { isError?: boolean }).isError).toBe(true)
    expect(textOf(conflict)).toContain('conflicto de revisión')
    const stillRegla = parseToolResult(
      await client.callTool({ name: 'cortex_read', arguments: { id: created.id } }),
    ) as { kind: string; rev: number }
    expect(stillRegla.kind).toBe('regla')
    expect(stillRegla.rev).toBe(2)

    await client.close()
  })
})

// ─── Schemas de tools declaran issue/tags (task 5.5) ─────────────────────────

describe('tools/list — issue y tags en schemas (5.5)', () => {
  test('cortex_search declara issue y tags en inputSchema', async () => {
    const client = makeClient()
    await connectClient(client)

    const toolsResult = await client.listTools()
    const searchTool = toolsResult.tools.find((t) => t.name === 'cortex_search')
    expect(searchTool).toBeDefined()

    const props = (searchTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    expect(props['issue']).toBeDefined()
    expect(props['tags']).toBeDefined()
    // tags debe ser un array
    expect((props['tags'] as { type?: string }).type).toBe('array')

    await client.close()
  })

  test('cortex_list declara issue en inputSchema', async () => {
    const client = makeClient()
    await connectClient(client)

    const toolsResult = await client.listTools()
    const listTool = toolsResult.tools.find((t) => t.name === 'cortex_list')
    expect(listTool).toBeDefined()

    const props = (listTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    expect(props['issue']).toBeDefined()

    await client.close()
  })

  test('cortex_update declara issue con tipo string y null en inputSchema', async () => {
    const client = makeClient()
    await connectClient(client)

    const toolsResult = await client.listTools()
    const updateTool = toolsResult.tools.find((t) => t.name === 'cortex_update')
    expect(updateTool).toBeDefined()

    const props = (updateTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    expect(props['issue']).toBeDefined()
    // issue debe aceptar string o null (anyOf o nullable)
    const issueProp = props['issue'] as Record<string, unknown>
    // Puede ser { anyOf: [{type:'string'},{type:'null'}] } o { type: ['string','null'] }
    const hasStringAndNull =
      (Array.isArray(issueProp['anyOf']) &&
        (issueProp['anyOf'] as Array<Record<string, unknown>>).some((t) => t['type'] === 'string') &&
        (issueProp['anyOf'] as Array<Record<string, unknown>>).some((t) => t['type'] === 'null')) ||
      (Array.isArray(issueProp['type']) &&
        (issueProp['type'] as string[]).includes('string') &&
        (issueProp['type'] as string[]).includes('null'))
    expect(hasStringAndNull).toBe(true)

    await client.close()
  })
})

// ─── cortex_update con issue null y cortex_search con tags (task 5.5) ─────────

describe('cortex_update issue:null y cortex_search tags (5.5)', () => {
  test('cortex_update {issue:null} quita el issue existente', async () => {
    const client = makeClient()
    await connectClient(client)

    // Crea nota con issue
    const writeResult = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: `Nota con issue para borrar vía MCP ${Date.now()}`,
        body_md: 'Configuración del módulo de crédito hipotecario en cartera con issue asignado para test de borrado por null en cortex_update.',
        app: 'cartera',
        kind: 'regla',
        author: 'mcp-test',
        force: true,
        reason: 'fixture de test',
      },
    })
    const created = parseToolResult(writeResult) as { id: string; rev: number }
    expect(created.rev).toBe(1)

    // Actualiza con issue inicial
    const withIssue = await client.callTool({
      name: 'cortex_update',
      arguments: { id: created.id, issue: 'MCP-TEST-1', author: 'mcp-test', reason: 'asignar issue' },
    })
    const afterSet = parseToolResult(withIssue) as { issue: string; rev: number }
    expect(afterSet.issue).toBe('MCP-TEST-1')
    expect(afterSet.rev).toBe(2)

    // Ahora quita el issue con null
    const withNull = await client.callTool({
      name: 'cortex_update',
      arguments: { id: created.id, issue: null, author: 'mcp-test', reason: 'quitar issue' },
    })
    const afterNull = parseToolResult(withNull) as { issue: string | null; rev: number }
    expect(afterNull.issue).toBeNull()
    expect(afterNull.rev).toBe(3)

    await client.close()
  })

  test('cortex_search {tags} filtra (bug #14: antes devolvía todo)', async () => {
    const client = makeClient()
    await connectClient(client)

    // Crea nota CON tag area:test-mcp
    const withTagResult = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: `Nota con tag area:test-mcp para filtro ${Date.now()}`,
        body_md: 'Regla de tasas de interés diferenciadas para préstamos de largo plazo en la financiera con tag de área de test para validar el filtro por tags en cortex_search.',
        app: 'cartera',
        kind: 'regla',
        author: 'mcp-test',
        tags: ['area:test-mcp'],
        force: true,
        reason: 'fixture de test',
      },
    })
    const noteWithTag = parseToolResult(withTagResult) as { id: string }

    // Crea nota SIN tag (mismo tema para que aparezca en búsqueda)
    await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: `Nota sin tag area:test-mcp para filtro ${Date.now()}`,
        body_md: 'Configuración de tasas de interés diferenciadas para créditos hipotecarios en la financiera sin tag de área para validar que el filtro la excluye en cortex_search.',
        app: 'cartera',
        kind: 'regla',
        author: 'mcp-test',
        force: true,
        reason: 'fixture de test',
      },
    })

    // Busca sin filtro: ambas deben aparecer
    const noFilterResult = await client.callTool({
      name: 'cortex_search',
      arguments: { q: 'tasas diferenciadas financiera', app: 'cartera' },
    })
    const noFilterIds = (parseToolResult(noFilterResult) as Array<{ id: string }>).map((r) => r.id)
    expect(noFilterIds).toContain(noteWithTag.id)

    // Busca CON filtro tags: solo la nota con el tag debe aparecer
    const tagFilterResult = await client.callTool({
      name: 'cortex_search',
      arguments: { q: 'tasas diferenciadas financiera', app: 'cartera', tags: ['area:test-mcp'] },
    })
    const tagFilterIds = (parseToolResult(tagFilterResult) as Array<{ id: string }>).map((r) => r.id)
    expect(tagFilterIds).toContain(noteWithTag.id)
    // La nota SIN tag no debe aparecer
    // (si aparece, el filtro no funciona — era el bug #14)
    for (const id of tagFilterIds) {
      if (id !== noteWithTag.id) {
        // Verificar que no es la nota sin tag
        const readResult = await client.callTool({ name: 'cortex_read', arguments: { id } })
        const note = parseToolResult(readResult) as { tags?: string[] }
        expect(note.tags ?? []).toContain('area:test-mcp')
      }
    }

    await client.close()
  })
})

// ─── cortex_search/cortex_list con filtro issue via MCP (task 5.5 / bloqueantes R1) ───

describe('cortex_search y cortex_list con issue via MCP (5.5)', () => {
  let noteMcpIss1Id = ''  // issue: MCP-ISS-1
  let noteMcpIss2Id = ''  // issue: MCP-ISS-2 — para verificar exclusión

  beforeAll(async () => {
    // Arranca un cliente solo para setup de fixtures
    const client = makeClient()
    await connectClient(client)

    const r1 = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: `Nota MCP-ISS-1 hipotecario ${Date.now()}`,
        body_md: 'Configuración del módulo hipotecario en cartera con issue MCP-ISS-1 para verificar el filtro por issue en cortex_search y cortex_list via MCP.',
        app: 'cartera',
        kind: 'regla',
        author: 'mcp-test',
        issue: 'MCP-ISS-1',
        force: true,
        reason: 'fixture de test',
      },
    })
    const d1 = parseToolResult(r1) as { id: string }
    noteMcpIss1Id = d1.id

    const r2 = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: `Nota MCP-ISS-2 hipotecario ${Date.now()}`,
        body_md: 'Configuración del módulo hipotecario en cartera con issue MCP-ISS-2 para verificar que el filtro por issue excluye correctamente en cortex_search y cortex_list via MCP.',
        app: 'cartera',
        kind: 'regla',
        author: 'mcp-test',
        issue: 'MCP-ISS-2',
        force: true,
        reason: 'fixture de test',
      },
    })
    const d2 = parseToolResult(r2) as { id: string }
    noteMcpIss2Id = d2.id

    await client.close()
    console.log(`[mcp.test 5.5] noteMcpIss1Id=${noteMcpIss1Id}, noteMcpIss2Id=${noteMcpIss2Id}`)
  }, 15 * 60 * 1000)

  test('cortex_search {q, issue:"mcp-iss-1"} incluye ISS-1 y excluye ISS-2 (case-insensitive)', async () => {
    // Verifica el camino: src/tools/mcp-server.ts:62 → hybridSearch(prisma, q, { issue })
    const client = makeClient()
    await connectClient(client)

    const result = await client.callTool({
      name: 'cortex_search',
      arguments: { q: 'modulo hipotecario cartera', issue: 'mcp-iss-1' },
    })
    const ids = (parseToolResult(result) as Array<{ id: string }>).map((r) => r.id)

    expect(ids).toContain(noteMcpIss1Id)
    // Si se quita issue de hybridSearch en mcp-server.ts:62, ISS-2 aparece — falla aquí
    expect(ids).not.toContain(noteMcpIss2Id)

    await client.close()
  })

  test('cortex_list {issue:"MCP-ISS-1"} incluye ISS-1 y excluye ISS-2 via MCP tool', async () => {
    // Verifica el camino: src/tools/mcp-server.ts:300 → listNotes(prisma, { issue })
    const client = makeClient()
    await connectClient(client)

    const result = await client.callTool({
      name: 'cortex_list',
      arguments: { issue: 'MCP-ISS-1' },
    })
    const data = parseToolResult(result) as Array<{ id: string }>
    const ids = data.map((r) => r.id)

    expect(ids).toContain(noteMcpIss1Id)
    // Si se quita issue de listNotes en mcp-server.ts:300, ISS-2 aparece — falla aquí
    expect(ids).not.toContain(noteMcpIss2Id)

    await client.close()
  })
})

describe('MCP: force con reason (task 4.5 iv)', () => {
  test('cortex_write con force: true sin reason → isError con "reason" en el texto', async () => {
    const client = makeClient()
    await connectClient(client)

    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota de test para force sin reason',
        body_md: 'Contenido de test para verificar que force sin reason lanza error.',
        app: 'general',
        kind: 'regla',
        author: 'mcp-test',
        force: true,
        // sin reason
      },
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('reason')

    await client.close()
  })

  test('cortex_write con force: true y reason → nota creada; cortex_read y cortex_list traen force_reason', async () => {
    const client = makeClient()
    await connectClient(client)

    const writeResult = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota de test para force con reason (MCP)',
        body_md: 'Contenido de test para verificar que force con reason persiste el motivo.',
        app: 'general',
        kind: 'regla',
        author: 'mcp-test',
        force: true,
        reason: 'es una nota de test, no un duplicado',
      },
    })
    expect((writeResult as { isError?: boolean }).isError).toBeFalsy()
    const created = parseToolResult(writeResult) as { id: string; force_reason?: string }
    expect(created.force_reason).toBe('es una nota de test, no un duplicado')

    // cortex_read trae force_reason
    const readResult = await client.callTool({
      name: 'cortex_read',
      arguments: { id: created.id },
    })
    const read = parseToolResult(readResult) as { force_reason?: string }
    expect(read.force_reason).toBe('es una nota de test, no un duplicado')

    // cortex_list trae force_reason
    const listResult = await client.callTool({
      name: 'cortex_list',
      arguments: { app: 'general' },
    })
    const list = parseToolResult(listResult) as Array<{ id: string; force_reason?: string }>
    const found = list.find((n) => n.id === created.id)
    expect(found?.force_reason).toBe('es una nota de test, no un duplicado')

    await client.close()
  })
})
