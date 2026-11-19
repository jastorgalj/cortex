/**
 * test/alias-argumentos.test.ts — Integración: alias de argumentos, author por defecto, issue:null.
 *
 * Patrón de test/mcp.test.ts: Client + StreamableHTTPClientTransport.
 * Para header: new StreamableHTTPClientTransport(url, {requestInit: {headers: {...}}}).
 * Para clientInfo.name vacío y header en blanco: fetch crudo (como mcp-sessions.test.ts:70-90).
 * Puerto exclusivo: 13094.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { warmup } from '../src/db/embeddings.ts'
import { createApp } from '../src/index.ts'

const TEST_PORT = 13094
const BASE_URL = `http://localhost:${TEST_PORT}`
const MCP_URL = new URL(`${BASE_URL}/mcp`)

const prisma = new PrismaClient()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverApp: any = null

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
}

beforeAll(async () => {
  await prisma.$executeRaw`TRUNCATE notes CASCADE`
  console.log('[alias.test] Calentando modelo ONNX...')
  await warmup()
  console.log('[alias.test] Modelo listo.')
  serverApp = createApp()
  serverApp.listen(TEST_PORT)
  console.log(`[alias.test] Servidor escuchando en ${BASE_URL}`)
}, 15 * 60 * 1000)

afterAll(async () => {
  serverApp?.stop()
  await prisma.$disconnect()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClient(name = 'mi-cliente'): Client {
  return new Client({ name, version: '1' })
}

async function connectClient(client: Client, headers?: Record<string, string>): Promise<void> {
  const transport = new StreamableHTTPClientTransport(MCP_URL, headers ? { requestInit: { headers } } : undefined)
  await client.connect(transport)
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content.find((c) => c.type === 'text')?.text ?? ''
}

function parseResult(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const text = textOf(result)
  try { return JSON.parse(text) } catch { return text }
}

// ─── tools/list: sin alias en schema ──────────────────────────────────────────

describe('tools/list', () => {
  test('no contiene query|text|body|content|markdown; q y body_md siguen required; author fuera de required en write/update y dentro en delete; issue de cortex_write admite null', async () => {
    const client = makeClient()
    await connectClient(client)
    const tools = await client.listTools()
    await client.close()

    const ALIAS_FORBIDDEN = ['query', 'text', 'body', 'content', 'markdown']

    for (const tool of tools.tools) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] }
      for (const alias of ALIAS_FORBIDDEN) {
        expect(
          Object.keys(schema.properties ?? {}).includes(alias),
          `tool ${tool.name} no debe tener propiedad '${alias}'`,
        ).toBe(false)
      }
    }

    // cortex_search: q requerido
    const search = tools.tools.find((t) => t.name === 'cortex_search')!
    const searchSchema = search.inputSchema as { properties?: Record<string, unknown>; required?: string[] }
    expect(searchSchema.required ?? []).toContain('q')

    // cortex_write: body_md requerido, author NO requerido, issue acepta null
    const write = tools.tools.find((t) => t.name === 'cortex_write')!
    const writeSchema = write.inputSchema as {
      properties?: Record<string, { type?: string | string[]; anyOf?: unknown[] }>
      required?: string[]
    }
    expect(writeSchema.required ?? []).toContain('body_md')
    expect(writeSchema.required ?? []).not.toContain('author')
    // issue debe aceptar string y null
    const issueProp = writeSchema.properties?.issue as { anyOf?: Array<{ type: string }>; type?: string | string[] } | undefined
    expect(issueProp).toBeDefined()
    const typesAllowed = issueProp!.anyOf
      ? issueProp!.anyOf.map((t) => (t as { type: string }).type)
      : Array.isArray(issueProp!.type) ? issueProp!.type : [issueProp!.type]
    expect(typesAllowed).toContain('null')

    // cortex_update: author NO requerido
    const update = tools.tools.find((t) => t.name === 'cortex_update')!
    const updateSchema = update.inputSchema as { required?: string[] }
    expect(updateSchema.required ?? []).not.toContain('author')

    // cortex_delete: author SÍ requerido
    const del_ = tools.tools.find((t) => t.name === 'cortex_delete')!
    const delSchema = del_.inputSchema as { required?: string[] }
    expect(delSchema.required ?? []).toContain('author')
  })
})

// ─── Alias en cortex_search ────────────────────────────────────────────────────

describe('cortex_search acepta alias query y text', () => {
  test('cortex_search acepta query como alias de q', async () => {
    // Primero crear nota de referencia con titulo único
    const clientW = makeClient()
    await connectClient(clientW)
    await clientW.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-1 nota para busqueda por query',
        body_md: 'Contenido de prueba para alias query en cortex_search',
        app: 'general',
        kind: 'pitfall',
        author: 'tester',
      },
    })
    await clientW.close()

    const client = makeClient()
    await connectClient(client)
    const result = await client.callTool({
      name: 'cortex_search',
      arguments: { query: 'ZX-ALIAS-1' },
    })
    await client.close()
    const data = parseResult(result) as Array<{ id: string }>
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)
  })

  test('cortex_search acepta text como alias de q', async () => {
    const client = makeClient()
    await connectClient(client)
    const result = await client.callTool({
      name: 'cortex_search',
      arguments: { text: 'ZX-ALIAS-1' },
    })
    await client.close()
    const data = parseResult(result) as Array<{ id: string }>
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)
  })

  test('q y query distintos → isError con texto de conflicto', async () => {
    const client = makeClient()
    await connectClient(client)
    const result = await client.callTool({
      name: 'cortex_search',
      arguments: { q: 'valor-a', query: 'valor-b' },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('q')
    expect(textOf(result)).toContain('query')
    expect(textOf(result)).toContain('Error en cortex_search')
  })
})

// ─── Alias en cortex_write / cortex_update ────────────────────────────────────

describe('cortex_write y cortex_update aceptan aliases de body_md', () => {
  test('cortex_write acepta content como alias de body_md', async () => {
    const client = makeClient()
    await connectClient(client)
    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-2 nota content alias',
        content: 'Contenido via alias content para cortex_write',
        app: 'general',
        kind: 'decision',
        author: 'tester',
        force: true,
        reason: 'test alias content',
      },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const data = parseResult(result) as { body_md?: string }
    expect(data.body_md).toBe('Contenido via alias content para cortex_write')
  })

  test('cortex_write acepta body como alias de body_md', async () => {
    const client = makeClient()
    await connectClient(client)
    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-3 nota body alias',
        body: 'Contenido via alias body para cortex_write',
        app: 'general',
        kind: 'sistema',
        author: 'tester',
        force: true,
        reason: 'nota de test, alias diferente',
      },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).not.toBe(true)
  })

  test('cortex_write acepta markdown como alias de body_md', async () => {
    const client = makeClient()
    await connectClient(client)
    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-4 nota markdown alias',
        markdown: 'Contenido via alias markdown para cortex_write',
        app: 'general',
        kind: 'flujo',
        author: 'tester',
        force: true,
        reason: 'alias markdown, nota diferente',
      },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).not.toBe(true)
  })

  test('body_md y content con valores distintos → isError', async () => {
    const client = makeClient()
    await connectClient(client)
    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-conflicto',
        body_md: 'canonico',
        content: 'diferente',
        app: 'general',
        kind: 'pitfall',
        author: 'tester',
      },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('Error en cortex_write')
    expect(textOf(result)).toContain('body_md')
    expect(textOf(result)).toContain('content')
  })

  test('cortex_update acepta body como alias de body_md', async () => {
    // Primero crear nota
    const clientW = makeClient()
    await connectClient(clientW)
    const created = await clientW.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-5 nota para actualizar con body alias',
        body_md: 'Original body_md',
        app: 'general',
        kind: 'regla',
        author: 'tester',
        force: true,
        reason: 'test create para update alias body',
      },
    })
    await clientW.close()
    const createdData = parseResult(created) as { id?: string }
    const noteId = createdData.id ?? ''
    expect(noteId).toBeTruthy()

    // Actualizar con alias body
    const clientU = makeClient()
    await connectClient(clientU)
    const result = await clientU.callTool({
      name: 'cortex_update',
      arguments: {
        id: noteId,
        body: 'Cuerpo actualizado via alias body',
        title: 'ZX-ALIAS-5 nota actualizada',
        author: 'tester',
      },
    })
    await clientU.close()
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const updated = parseResult(result) as { body_md?: string }
    expect(updated.body_md).toBe('Cuerpo actualizado via alias body')
  })
})

// ─── author por defecto ───────────────────────────────────────────────────────

describe('author por defecto en cortex_write y cortex_update', () => {
  test('El header x-cortex-author gana al nombre del cliente', async () => {
    const client = makeClient('mi-cliente')
    await connectClient(client, { 'x-cortex-author': 'ana' })
    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-6 nota autor header gana cliente',
        body_md: 'Probando que header gana al clientInfo.name',
        app: 'general',
        kind: 'pitfall',
        force: true,
        reason: 'test autor infierido',
      },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const data = parseResult(result) as { author?: string }
    const author = data.author
    expect(author).toBe('ana')
  })

  test('El nombre del cliente gana cuando no hay header', async () => {
    const client = makeClient('mi-cliente')
    await connectClient(client) // sin header
    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-7 nota autor cliente gana sin header',
        body_md: 'Probando que clientInfo.name gana cuando no hay header',
        app: 'general',
        kind: 'decision',
        force: true,
        reason: 'test autor infierido desde cliente',
      },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const data = parseResult(result) as { author?: string }
    const author = data.author
    expect(author).toBe('mi-cliente')
  })

  test('Sin ninguna fuente útil el author es agente', async () => {
    // Usar clientInfo.name vacío y sin header: fetch crudo para evitar que el SDK rechace name:""
    const initRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: '', version: '1' },
        },
      }),
    })
    expect(initRes.status).toBe(200)
    const sessionId = initRes.headers.get('mcp-session-id')!
    expect(sessionId).toBeTruthy()

    const writeRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'cortex_write',
          arguments: {
            title: 'ZX-ALIAS-8 nota autor agente',
            body_md: 'Sin autor, sin header, sin cliente: debe ser agente',
            app: 'general',
            kind: 'sistema',
            force: true,
            reason: 'test autor agente fallback',
          },
        },
      }),
    })
    expect(writeRes.status).toBe(200)
    const body = (await writeRes.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }
    expect(body.result.isError).not.toBe(true)
    const data = JSON.parse(body.result.content[0]!.text) as { author?: string }
    const author = data.author
    expect(author).toBe('agente')
  })

  test('Un header en blanco se ignora (sube al cliente)', async () => {
    // Usar fetch crudo para pasar header con espacios
    const initRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'x-cortex-author': '   ' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'cliente-blanco', version: '1' },
        },
      }),
    })
    expect(initRes.status).toBe(200)
    const sessionId = initRes.headers.get('mcp-session-id')!

    const writeRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId, 'x-cortex-author': '   ' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'cortex_write',
          arguments: {
            title: 'ZX-ALIAS-9 nota header blanco',
            body_md: 'Header en blanco: author debe ser el cliente',
            app: 'general',
            kind: 'flujo',
            force: true,
            reason: 'test header blanco sube a cliente',
          },
        },
      }),
    })
    expect(writeRes.status).toBe(200)
    const body = (await writeRes.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }
    expect(body.result.isError).not.toBe(true)
    const data = JSON.parse(body.result.content[0]!.text) as { author?: string }
    const author = data.author
    expect(author).toBe('cliente-blanco')
  })

  test('author: "" enviado explícitamente sigue rechazado', async () => {
    // Verifica que test/mcp.test.ts:204 sigue funcionando: author vacío = error
    const client = makeClient()
    await connectClient(client)
    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota sin autor explicito vacio',
        body_md: 'Contenido',
        app: 'general',
        kind: 'pitfall',
        author: '',
      },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('author')
  })

  test('Borrado sin author → isError', async () => {
    // cortex_delete NO tiene default: author es requerido
    const client = makeClient()
    await connectClient(client)
    const result = await client.callTool({
      name: 'cortex_delete',
      arguments: { id: '01JZZZZZZZZZZZZZZZZZZZZZZZ', reason: 'test borrado sin author' },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('author')
  })

  // ─ B1: cortex_update usa clientName cuando author es undefined ───────────────

  test('El nombre del cliente gana al valor por defecto en cortex_update', async () => {
    // Crear nota con author explícito distinto del nombre del cliente
    const clientW = makeClient('cliente-update')
    await connectClient(clientW)
    const created = await clientW.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-B1 nota update default author',
        body_md: 'Contenido rev 1 con author explícito distinto del cliente',
        app: 'general',
        kind: 'pitfall',
        author: 'autor-distinto',
        force: true,
        reason: 'crear rev 1 con author explícito',
      },
    })
    await clientW.close()
    const createdData = parseResult(created) as { id?: string }
    const noteId = createdData.id ?? ''
    expect(noteId).toBeTruthy()

    // Actualizar sin author → debe resolver al nombre del cliente ('cliente-update')
    const clientU = makeClient('cliente-update')
    await connectClient(clientU)
    const updated = await clientU.callTool({
      name: 'cortex_update',
      arguments: { id: noteId, body_md: 'Contenido rev 2 sin author explícito' },
    })
    await clientU.close()
    expect((updated as { isError?: boolean }).isError).not.toBe(true)
    const updatedData = parseResult(updated) as { author?: string; rev?: number }
    expect(updatedData.author).toBe('cliente-update')
    expect(updatedData.rev).toBe(2)

    // cortex_history conserva rev 1 con 'autor-distinto'
    const clientH = makeClient('cliente-update')
    await connectClient(clientH)
    const histResult = await clientH.callTool({ name: 'cortex_history', arguments: { id: noteId } })
    await clientH.close()
    expect((histResult as { isError?: boolean }).isError).not.toBe(true)
    const revisions = parseResult(histResult) as { items: Array<{ rev: number; author?: string }> }
    expect(Array.isArray(revisions.items)).toBe(true)
    expect(revisions.items.length).toBeGreaterThan(0)
    const rev1 = revisions.items.find((r) => r.rev === 1)
    expect(rev1).toBeDefined()
    expect(rev1?.author).toBe('autor-distinto')
  })

  // ─ B2(b): El argumento explícito gana al header ──────────────────────────────

  test('El argumento author gana al header x-cortex-author', async () => {
    const client = makeClient('mi-cliente')
    await connectClient(client, { 'x-cortex-author': 'ana' })
    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-B2b nota argumento gana al header',
        body_md: 'El argumento author:beto debe ganar al header x-cortex-author:ana',
        app: 'general',
        kind: 'pitfall',
        author: 'beto',
        force: true,
        reason: 'test argumento gana header',
      },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const data = parseResult(result) as { author?: string }
    expect(data.author).toBe('beto')
  })

  // ─ B2(c): author vacío con header presente sigue rechazado ───────────────────

  test('author vacío con header presente sigue rechazado (sin recurrir a otras fuentes)', async () => {
    const client = makeClient('mi-cliente')
    await connectClient(client, { 'x-cortex-author': 'ana' })
    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-B2c nota author vacio con header',
        body_md: 'El header está presente pero author:"" debe seguir siendo error',
        app: 'general',
        kind: 'pitfall',
        author: '',
      },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('author')
  })

  // ─ B2(d): Borrado sin author con nota real + header → isError, nota persiste ─

  test('Borrado sin author con nota real + header → isError, nota sigue existiendo', async () => {
    // Crear nota real
    const clientW = makeClient()
    await connectClient(clientW)
    const created = await clientW.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-B2d nota para borrar sin author',
        body_md: 'Nota para probar borrado sin author con header presente',
        app: 'general',
        kind: 'pitfall',
        author: 'tester',
        force: true,
        reason: 'crear nota para test borrado sin author',
      },
    })
    await clientW.close()
    const createdData = parseResult(created) as { id?: string }
    const noteId = createdData.id ?? ''
    expect(noteId).toBeTruthy()

    // Intentar borrar sin author (cortex_delete lo exige en schema)
    // Header presente: x-cortex-author:ana — no debe rescatar la falta de author en delete
    const clientD = makeClient()
    await connectClient(clientD, { 'x-cortex-author': 'ana' })
    const result = await clientD.callTool({
      name: 'cortex_delete',
      arguments: { id: noteId, reason: 'test borrado sin author con header' },
    })
    await clientD.close()
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('author')

    // Verificar que la nota sigue existiendo en cortex_list
    const clientL = makeClient()
    await connectClient(clientL)
    const listResult = await clientL.callTool({ name: 'cortex_list', arguments: {} })
    await clientL.close()
    const notes = parseResult(listResult) as { items: Array<{ id: string }> }
    expect(notes.items.some((n) => n.id === noteId)).toBe(true)
  })
})

// ─── issue: null en cortex_write ──────────────────────────────────────────────

describe('issue: null en cortex_write', () => {
  test('issue: null guarda null', async () => {
    const client = makeClient()
    await connectClient(client)
    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-10 nota issue null',
        body_md: 'Nota con issue:null explícito',
        app: 'general',
        kind: 'pitfall',
        author: 'tester',
        issue: null,
        force: true,
        reason: 'test issue null',
      },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const data = parseResult(result) as { issue?: null | string }
    expect(data.issue).toBeNull()
  })

  test('issue: "" guarda null', async () => {
    const client = makeClient()
    await connectClient(client)
    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-11 nota issue string vacio',
        body_md: 'Nota con issue string vacío: debe guardarse como null',
        app: 'general',
        kind: 'decision',
        author: 'tester',
        issue: '',
        force: true,
        reason: 'test issue vacío',
      },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const data = parseResult(result) as { issue?: null | string }
    expect(data.issue).toBeNull()
  })

  test('issue: "   " (solo espacios) guarda null', async () => {
    const client = makeClient()
    await connectClient(client)
    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-12 nota issue solo espacios',
        body_md: 'Nota con issue de solo espacios: debe ser null',
        app: 'general',
        kind: 'sistema',
        author: 'tester',
        issue: '   ',
        force: true,
        reason: 'test issue espacios',
      },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const data = parseResult(result) as { issue?: null | string }
    expect(data.issue).toBeNull()
  })

  test('issue: "ABC-1" se guarda tal cual', async () => {
    const client = makeClient()
    await connectClient(client)
    const result = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-13 nota issue ABC-1',
        body_md: 'Nota con issue ABC-1: debe persistir tal cual',
        app: 'general',
        kind: 'regla',
        author: 'tester',
        issue: 'ABC-1',
        force: true,
        reason: 'test issue real',
      },
    })
    await client.close()
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const data = parseResult(result) as { issue?: null | string }
    expect(data.issue).toBe('ABC-1')
  })

  test('cortex_update con issue: "" sigue siendo error (escenario vigente)', async () => {
    // Verificar que test/notes.test.ts:778-789 sigue verde sin editar
    const clientW = makeClient()
    await connectClient(clientW)
    const created = await clientW.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-14 nota para update issue vacio',
        body_md: 'Nota para probar update con issue vacío',
        app: 'general',
        kind: 'pitfall',
        author: 'tester',
        issue: 'TST-100',
        force: true,
        reason: 'test create para update issue vacio',
      },
    })
    await clientW.close()
    const createdData = parseResult(created) as { id?: string }
    const noteId = createdData.id ?? ''
    expect(noteId).toBeTruthy()

    const clientU = makeClient()
    await connectClient(clientU)
    const result = await clientU.callTool({
      name: 'cortex_update',
      arguments: { id: noteId, issue: '', author: 'tester' },
    })
    await clientU.close()
    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(textOf(result)).toContain('issue')
  })

  // ─ B2(a): issue null no rompe el aviso de duplicado ─────────────────────────

  test('issue null no rompe el aviso de duplicado (similar_exists)', async () => {
    // Crear nota de referencia sin issue (con force para garantizar creación)
    const clientW = makeClient()
    await connectClient(clientW)
    await clientW.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-B2a nota duplicado issue null',
        body_md: 'Contenido idéntico para probar duplicado con issue null',
        app: 'general',
        kind: 'pitfall',
        author: 'tester',
        force: true,
        reason: 'crear nota de referencia para test duplicado',
      },
    })
    await clientW.close()

    // Intentar crear misma nota con issue:null y sin force → debe responder similar_exists, no error
    const clientW2 = makeClient()
    await connectClient(clientW2)
    const result = await clientW2.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'ZX-ALIAS-B2a nota duplicado issue null',
        body_md: 'Contenido idéntico para probar duplicado con issue null',
        app: 'general',
        kind: 'pitfall',
        author: 'tester',
        issue: null,
      },
    })
    await clientW2.close()
    expect((result as { isError?: boolean }).isError).not.toBe(true)
    const data = parseResult(result) as { status?: string; candidates?: unknown[] }
    expect(data.status).toBe('similar_exists')
    expect(Array.isArray(data.candidates)).toBe(true)
  })
})
