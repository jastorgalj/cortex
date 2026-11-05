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
import { createApp } from '../src/index.ts'

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MCP server — cortex tools', () => {
  test('tools/list devuelve exactamente las siete tools nombradas (todas con prefijo cortex_)', async () => {
    const client = makeClient()
    await connectClient(client)

    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).sort()

    expect(names).toEqual([
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

  test('initialize responde serverInfo.name=cortex y version=0.2.0', async () => {
    const client = makeClient()
    const transport = new StreamableHTTPClientTransport(MCP_URL)
    await client.connect(transport)
    const serverInfo = client.getServerVersion()
    expect(serverInfo?.name).toBe('cortex')
    expect(serverInfo?.version).toBe('0.2.0')
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
})
