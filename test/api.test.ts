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
  test('responde 200 con {status, notes, model_loaded, sessions, uptime_s}', async () => {
    const r = await fetch(`${BASE_URL}/health`)
    expect(r.status).toBe(200)
    const body = await r.json() as {
      status: string
      notes: number
      db_pool: string
      model_loaded: boolean
      sessions: number
      uptime_s: number
    }
    expect(body.status).toBe('ok')
    expect(typeof body.notes).toBe('number')
    expect(typeof body.model_loaded).toBe('boolean')
    // model_loaded debe ser true porque hicimos warmup en beforeAll
    expect(body.model_loaded).toBe(true)
    expect(typeof body.sessions).toBe('number')
    expect(typeof body.uptime_s).toBe('number')
    expect(body.db_pool).toBe('active')
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

  test('GET /api/notes/:id devuelve force_reason cuando la nota fue creada con force (task 4.5 v)', async () => {
    // Crea una nota con force + reason via createNote directo
    const { createNote } = await import('../src/db/notes.ts')
    const r = await createNote(prisma, {
      title: 'Nota con force reason para test API',
      body_md: 'Contenido para verificar que force_reason aparece en la API REST.',
      app: 'general',
      kind: 'regla',
      author: 'api-test',
      force: true,
      reason: 'test api force_reason',
    })
    expect(r.status).toBe('created')
    if (r.status !== 'created') return
    const noteId = r.note.id

    const res = await fetch(`${BASE_URL}/api/notes/${noteId}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { force_reason?: string }
    expect(body.force_reason).toBe('test api force_reason')
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

// ─── Filtros issue y tags en /api/search (task 5.7) ───────────────────────────

describe('GET /api/search — filtros issue y tags (5.7)', () => {
  let noteTagAxId = ''   // issue:api-1, tags:[area:x]
  let noteTagAxRyId = '' // issue:api-1, tags:[area:x, repo:y]
  let noteTagNoneId = '' // issue:api-1, sin tags
  let noteApi2Id = ''    // issue:api-2, mismo vocabulario — para verificar exclusión

  beforeAll(async () => {
    // Crear notas de fixture con issue/tags via MCP
    const client = new Client({ name: 'api-test-5.7', version: '1.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`))
    await client.connect(transport)

    const rA = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: `Nota API-1 con area:x ${Date.now()}`,
        body_md: 'Regla de gestión de rendimientos de inversión API-1 en la financiera con tag area:x para verificar el filtro por tags en la ruta REST de búsqueda.',
        app: 'cartera',
        kind: 'regla',
        author: 'api-test-5.7',
        issue: 'API-1',
        tags: ['area:x'],
        force: true,
        reason: 'fixture de test',
      },
    })
    const dataA = JSON.parse(((rA.content as Array<{type:string;text?:string}>).find(c => c.type==='text')?.text) ?? '{}') as {id:string}
    noteTagAxId = dataA.id

    const rB = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: `Nota API-1 con area:x repo:y ${Date.now()}`,
        body_md: 'Configuración de rendimientos de inversión API-1 en la financiera con tags area:x y repo:y para verificar el filtro AND por tags en la ruta REST de búsqueda.',
        app: 'cartera',
        kind: 'regla',
        author: 'api-test-5.7',
        issue: 'API-1',
        tags: ['area:x', 'repo:y'],
        force: true,
        reason: 'fixture de test',
      },
    })
    const dataB = JSON.parse(((rB.content as Array<{type:string;text?:string}>).find(c => c.type==='text')?.text) ?? '{}') as {id:string}
    noteTagAxRyId = dataB.id

    const rC = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: `Nota API-1 sin tags ${Date.now()}`,
        body_md: 'Análisis de rendimientos de inversión API-1 en la financiera sin tags para verificar que el filtro por tags la excluye correctamente en la ruta REST de búsqueda.',
        app: 'cartera',
        kind: 'regla',
        author: 'api-test-5.7',
        issue: 'API-1',
        force: true,
        reason: 'fixture de test',
      },
    })
    const dataC = JSON.parse(((rC.content as Array<{type:string;text?:string}>).find(c => c.type==='text')?.text) ?? '{}') as {id:string}
    noteTagNoneId = dataC.id

    // Nota con OTRO issue (API-2) — mismo vocabulario para que aparezca en búsqueda
    const rD = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: `Nota API-2 rendimientos inversion ${Date.now()}`,
        body_md: 'Revisión de rendimientos de inversión API-2 en la financiera con distinto issue para verificar que el filtro por issue excluye correctamente en la ruta REST de búsqueda.',
        app: 'cartera',
        kind: 'regla',
        author: 'api-test-5.7',
        issue: 'API-2',
        force: true,
        reason: 'fixture de test',
      },
    })
    const dataD = JSON.parse(((rD.content as Array<{type:string;text?:string}>).find(c => c.type==='text')?.text) ?? '{}') as {id:string}
    noteApi2Id = dataD.id

    await client.close()
    console.log(`[api.test 5.7] noteTagAxId=${noteTagAxId}, noteTagAxRyId=${noteTagAxRyId}, noteTagNoneId=${noteTagNoneId}, noteApi2Id=${noteApi2Id}`)
  }, 15 * 60 * 1000)

  test('/api/search?q=...&tags=area:x devuelve solo notas con area:x', async () => {
    const r = await fetch(`${BASE_URL}/api/search?q=rendimientos+inversion&tags=area:x`)
    expect(r.status).toBe(200)
    const results = await r.json() as Array<{ id: string }>
    const ids = results.map((x) => x.id)
    expect(ids).toContain(noteTagAxId)
    expect(ids).toContain(noteTagAxRyId) // también tiene area:x
    expect(ids).not.toContain(noteTagNoneId) // sin tags
  })

  test('/api/search?q=...&tags=area:x,repo:y (AND) devuelve solo notas con ambos tags', async () => {
    const r = await fetch(`${BASE_URL}/api/search?q=rendimientos+inversion&tags=area:x,repo:y`)
    expect(r.status).toBe(200)
    const results = await r.json() as Array<{ id: string }>
    const ids = results.map((x) => x.id)
    expect(ids).toContain(noteTagAxRyId) // tiene ambos
    expect(ids).not.toContain(noteTagAxId) // solo tiene area:x
    expect(ids).not.toContain(noteTagNoneId)
  })

  test('/api/search?q=...&tags=,area:x, (comas extras) normaliza igual que area:x', async () => {
    const r = await fetch(`${BASE_URL}/api/search?q=rendimientos+inversion&tags=%2Carea%3Ax%2C`)
    expect(r.status).toBe(200)
    const results = await r.json() as Array<{ id: string }>
    const ids = results.map((x) => x.id)
    // Mismo resultado que tags=area:x
    expect(ids).toContain(noteTagAxId)
    expect(ids).toContain(noteTagAxRyId)
    expect(ids).not.toContain(noteTagNoneId)
  })

  test('/api/search?q=...&issue=api-1 filtra por issue (case-insensitive) y excluye otro issue', async () => {
    const r = await fetch(`${BASE_URL}/api/search?q=rendimientos+inversion&issue=api-1`)
    expect(r.status).toBe(200)
    const results = await r.json() as Array<{ id: string; issue?: string | null }>
    const ids = results.map((x) => x.id)
    expect(ids).toContain(noteTagAxId)
    expect(ids).toContain(noteTagAxRyId)
    expect(ids).toContain(noteTagNoneId)
    // La nota con issue API-2 NO debe aparecer — esto hace fallar el test si se quita el filtro
    expect(ids).not.toContain(noteApi2Id)
    // Todos los resultados deben tener issue (no undefined)
    for (const r of results) {
      expect('issue' in r).toBe(true)
    }
  })

  test('/api/search?q=...&issue=api-2 devuelve nota API-2 y excluye notas API-1', async () => {
    const r = await fetch(`${BASE_URL}/api/search?q=rendimientos+inversion&issue=api-2`)
    expect(r.status).toBe(200)
    const results = await r.json() as Array<{ id: string }>
    const ids = results.map((x) => x.id)
    expect(ids).toContain(noteApi2Id)
    // Las 3 notas de API-1 no deben aparecer
    expect(ids).not.toContain(noteTagAxId)
    expect(ids).not.toContain(noteTagAxRyId)
    expect(ids).not.toContain(noteTagNoneId)
  })

  test('/api/search resultados incluyen campo issue', async () => {
    const r = await fetch(`${BASE_URL}/api/search?q=rendimientos+inversion&issue=API-1`)
    expect(r.status).toBe(200)
    const results = await r.json() as Array<{ id: string; issue?: string | null }>
    expect(results.length).toBeGreaterThan(0)
    const hit = results.find((x) => x.id === noteTagAxId)
    expect(hit).toBeDefined()
    expect(hit!.issue).toBe('API-1')
  })

  test('/api/search ids con issue/tags coinciden con hybridSearch directo', async () => {
    // REST
    const r = await fetch(`${BASE_URL}/api/search?q=rendimientos+inversion&tags=area:x&issue=API-1`)
    expect(r.status).toBe(200)
    const apiResults = await r.json() as Array<{ id: string }>
    const apiIds = apiResults.map((x) => x.id).sort()

    // Directo
    const dbResults = await hybridSearch(prisma, 'rendimientos inversion', { tags: ['area:x'], issue: 'API-1' }, 10)
    const dbIds = dbResults.map((x) => x.id).sort()

    expect(apiIds).toEqual(dbIds)
  })
})

// ─── filtro app en blanco via REST (task 3.4b) ───────────────────────────────

describe('GET /api/search: app en blanco no filtra', () => {
  test('app=%20%20%20 devuelve el mismo total que sin app', async () => {
    const q = 'tasa+especial'
    const rAll = await fetch(`${BASE_URL}/api/search?q=${q}`)
    const rBlank = await fetch(`${BASE_URL}/api/search?q=${q}&app=%20%20%20`)
    expect(rAll.status).toBe(200)
    expect(rBlank.status).toBe(200)
    const allResults = await rAll.json() as Array<{ id: string }>
    const blankResults = await rBlank.json() as Array<{ id: string }>
    expect(blankResults.length).toBe(allResults.length)
  })
})

// ─── GET /api/apps (task 3.4d) ───────────────────────────────────────────────

describe('GET /api/apps', () => {
  test('responde con apps (array) y vocabulary (canonicas, modo, aliases)', async () => {
    const r = await fetch(`${BASE_URL}/api/apps`)
    expect(r.status).toBe(200)
    const body = await r.json() as {
      apps: Array<{ app: string; count: number }>
      vocabulary: { canonicas: string[]; modo: string | null; aliases: Record<string, string> }
    }
    expect(Array.isArray(body.apps)).toBe(true)
    expect(body.apps.length).toBeGreaterThan(0)
    expect(Array.isArray(body.vocabulary.canonicas)).toBe(true)
    expect(body.vocabulary.canonicas).toContain('general')
    expect('modo' in body.vocabulary).toBe(true)
    expect('aliases' in body.vocabulary).toBe(true)
  })
})

// ─── MCP cortex_list include_general:false (task 3.4c) ───────────────────────

describe('cortex_list por MCP: include_general:false solo trae la app pedida', () => {
  test('con app=cartera e include_general:false no hay notas general', async () => {
    const client = new Client({ name: 'api-test-ig', version: '1.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`))
    await client.connect(transport)

    const result = await client.callTool({
      name: 'cortex_list',
      arguments: { app: 'cartera', include_general: false, limit: 100 },
    })
    const content = result.content as Array<{ type: string; text?: string }>
    const text = content.find((c) => c.type === 'text')?.text ?? ''
    const data = JSON.parse(text) as { items: Array<{ app: string }> }
    expect(data.items.every((n) => n.app === 'cartera')).toBe(true)

    await client.close()
  })
})

// ─── GET /api/search include_general=false (task 3.4d) ───────────────────────

describe('GET /api/search: include_general=false excluye general', () => {
  test('resultados no contienen notas de general cuando include_general=false', async () => {
    // Crear nota en app cartera para que haya resultados
    const r = await fetch(`${BASE_URL}/api/search?q=tasa+especial&app=cartera&include_general=false`)
    expect(r.status).toBe(200)
    const results = await r.json() as Array<{ app: string }>
    // Si hay resultados, ninguno debe ser general
    expect(results.every((n) => n.app !== 'general')).toBe(true)
  })
})

// ─── cortex_apps por MCP: nota borrada no se cuenta (task 3.4e) ──────────────

describe('cortex_apps por MCP: notas borradas no se cuentan', () => {
  test('crear y borrar una nota reduce el conteo de su app', async () => {
    const client = new Client({ name: 'api-test-apps', version: '1.0' })
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`))
    await client.connect(transport)

    // Conteo antes
    const before = await client.callTool({ name: 'cortex_apps', arguments: {} })
    const beforeText = (before.content as Array<{ type: string; text?: string }>)
      .find((c) => c.type === 'text')?.text ?? ''
    const beforeData = JSON.parse(beforeText) as {
      apps: Array<{ app: string; count: number }>
    }
    const carteraCountBefore = beforeData.apps.find((a) => a.app === 'cartera')?.count ?? 0

    // Crear nota en cartera
    const writeResult = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: 'Nota temp para test cortex_apps borrado',
        body_md: 'Contenido temporal para verificar que cortex_apps no cuenta borradas.',
        app: 'cartera',
        kind: 'regla',
        author: 'api-test-apps',
        force: true,
        reason: 'fixture test borrado',
      },
    })
    const writeContent = writeResult.content as Array<{ type: string; text?: string }>
    const writeText = writeContent.find((c) => c.type === 'text')?.text ?? ''
    const writeData = JSON.parse(writeText) as { id: string }
    const tempId = writeData.id

    // Borrar nota
    await client.callTool({
      name: 'cortex_delete',
      arguments: { id: tempId, author: 'api-test-apps', reason: 'fixture test borrado' },
    })

    // Conteo después: debe volver al valor original
    const after = await client.callTool({ name: 'cortex_apps', arguments: {} })
    const afterText = (after.content as Array<{ type: string; text?: string }>)
      .find((c) => c.type === 'text')?.text ?? ''
    const afterData = JSON.parse(afterText) as {
      apps: Array<{ app: string; count: number }>
    }
    const carteraCountAfter = afterData.apps.find((a) => a.app === 'cartera')?.count ?? 0

    expect(carteraCountAfter).toBe(carteraCountBefore)

    await client.close()
  })
})
