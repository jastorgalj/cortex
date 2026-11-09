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
