/**
 * test/api.test.ts — Task 3.2: Vista web y REST de solo lectura.
 *
 * Verifica:
 * - GET /api/search devuelve los mismos ids que cortex_search
 * - POST/PUT/PATCH/DELETE fuera de /mcp responden 404/405
 * - GET /health responde 200 con la estructura correcta
 * - GET / devuelve HTML
 * - GET /notes/:id devuelve HTML con la nota
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { warmup } from '../src/db/embeddings.ts'
import { createApp } from '../src/index.ts'
import { hybridSearch } from '../src/db/search.ts'

const TEST_PORT = 13092
const BASE_URL = `http://localhost:${TEST_PORT}`

const prisma = new PrismaClient()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverApp: any = null
let testNoteId = ''

beforeAll(async () => {
  await prisma.$executeRaw`TRUNCATE notes CASCADE`

  console.log('[api.test] Calentando modelo ONNX...')
  await warmup()
  console.log('[api.test] Modelo listo.')

  serverApp = createApp()
  serverApp.listen(TEST_PORT)

  // Crea una nota de prueba via MCP
  const client = new Client({ name: 'api-test-setup', version: '1.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`))
  await client.connect(transport)

  const result = await client.callTool({
    name: 'cortex_write',
    arguments: {
      title: 'Gestión de tasa especial en Cartera',
      body_md:
        'La tasa especial se configura por sucursal y aplica cuando el ejecutivo tiene permiso de edición. Requiere aprobación del gerente de riesgo.',
      app: 'cartera',
      kind: 'regla',
      tags: ['tasa-especial', 'permisos', 'test-api'],
      author: 'api-test-setup',
    },
  })
  const content = result.content as Array<{ type: string; text?: string }>
  const text = content.find((c) => c.type === 'text')?.text ?? ''
  const data = JSON.parse(text) as { id: string }
  testNoteId = data.id

  await client.close()
  console.log(`[api.test] Nota de prueba creada: ${testNoteId}`)
}, 15 * 60 * 1000)

afterAll(async () => {
  serverApp?.stop()
  await prisma.$disconnect()
})

// ─── Health ───────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  test('responde 200 con {status, notes, model_loaded}', async () => {
    const r = await fetch(`${BASE_URL}/health`)
    expect(r.status).toBe(200)
    const body = await r.json() as { status: string; notes: number; model_loaded: boolean }
    expect(body.status).toBe('ok')
    expect(typeof body.notes).toBe('number')
    expect(typeof body.model_loaded).toBe('boolean')
    // model_loaded debe ser true porque hicimos warmup en beforeAll
    expect(body.model_loaded).toBe(true)
  })
})

// ─── REST API ─────────────────────────────────────────────────────────────────

describe('GET /api/search — coincide con cortex_search', () => {
  test('/api/search?q=tasa especial devuelve los mismos ids que hybridSearch', async () => {
    const q = 'tasa especial'

    // Resultado via REST
    const r = await fetch(`${BASE_URL}/api/search?q=${encodeURIComponent(q)}`)
    expect(r.status).toBe(200)
    const apiResults = await r.json() as Array<{ id: string }>

    // Resultado via hybridSearch directo
    const dbResults = await hybridSearch(prisma, q, {}, 10)

    const apiIds = apiResults.map((x) => x.id).sort()
    const dbIds = dbResults.map((x) => x.id).sort()

    expect(apiIds).toEqual(dbIds)
    // La nota de prueba debe aparecer
    expect(apiIds).toContain(testNoteId)
  })

  test('/api/search sin q devuelve error 200 con campo error', async () => {
    const r = await fetch(`${BASE_URL}/api/search`)
    // Elysia devuelve 200 con body error (no es un status de error HTTP)
    const body = await r.json() as { error?: string }
    expect(body.error).toBeTruthy()
  })

  test('GET /api/notes/:id devuelve la nota completa', async () => {
    const r = await fetch(`${BASE_URL}/api/notes/${testNoteId}`)
    expect(r.status).toBe(200)
    const body = await r.json() as { id: string; title: string }
    expect(body.id).toBe(testNoteId)
    expect(body.title).toBe('Gestión de tasa especial en Cartera')
  })

  test('GET /api/notes/:id con id inexistente → 404', async () => {
    const r = await fetch(`${BASE_URL}/api/notes/01JZZZZZZZZZZZZZZZZZZZZZZZ`)
    expect(r.status).toBe(404)
  })
})

// ─── No hay escritura fuera de /mcp ───────────────────────────────────────────

describe('POST/PUT/PATCH/DELETE fuera de /mcp → 404/405', () => {
  const writeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'] as const

  for (const method of writeMethods) {
    test(`${method} /api/search → 405`, async () => {
      const r = await fetch(`${BASE_URL}/api/search`, { method })
      expect([404, 405]).toContain(r.status)
    })

    test(`${method} /api/notes/${testNoteId} → 405 (no modifica nada)`, async () => {
      const r = await fetch(`${BASE_URL}/api/notes/${testNoteId}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method !== 'DELETE' ? JSON.stringify({ title: 'Hacked' }) : undefined,
      })
      expect([404, 405]).toContain(r.status)

      // Verifica que la nota no fue modificada
      const check = await fetch(`${BASE_URL}/api/notes/${testNoteId}`)
      const note = await check.json() as { title: string }
      expect(note.title).toBe('Gestión de tasa especial en Cartera')
    })

    test(`${method} / → 405`, async () => {
      const r = await fetch(`${BASE_URL}/`, { method })
      expect([404, 405]).toContain(r.status)
    })

    test(`${method} /notes/${testNoteId} → 405`, async () => {
      const r = await fetch(`${BASE_URL}/notes/${testNoteId}`, { method })
      expect([404, 405]).toContain(r.status)
    })
  }
})

// ─── Vista web ────────────────────────────────────────────────────────────────

describe('Vista web de solo lectura', () => {
  test('GET / devuelve HTML con lista de notas', async () => {
    const r = await fetch(`${BASE_URL}/`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    const html = await r.text()
    expect(html).toContain('Gestión de tasa especial')
  })

  test('GET / — <title> contiene Cortex y no Novara KB', async () => {
    const r = await fetch(`${BASE_URL}/`)
    const html = await r.text()
    expect(html).toContain('Cortex')
    expect(html).not.toContain('Novara KB')
  })

  test('GET /notes/:id devuelve HTML con el markdown renderizado', async () => {
    const r = await fetch(`${BASE_URL}/notes/${testNoteId}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/html')
    const html = await r.text()
    expect(html).toContain('tasa especial')
    expect(html).toContain('<p>') // markdown renderizado a HTML
  })

  test('GET /notes/:id — <title> contiene Cortex y no Novara KB', async () => {
    const r = await fetch(`${BASE_URL}/notes/${testNoteId}`)
    const html = await r.text()
    expect(html).toContain('Cortex')
    expect(html).not.toContain('Novara KB')
  })
})
