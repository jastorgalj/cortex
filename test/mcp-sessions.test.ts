/**
 * test/mcp-sessions.test.ts — Integración de sesiones MCP (grupo 3.5).
 *
 * Flujo crudo con fetch, sin cliente SDK:
 *  - tools/list con un mcp-session-id inventado → 404 JSON-RPC (error.code -32001, id null)
 *  - initialize sin id → 200 con mcp-session-id nuevo
 *  - tools/list con ese id → 200 y lista las 7 tools
 *
 * Patrón de test/mcp.test.ts: createApp() en puerto propio 13192.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { warmup } from '../src/db/embeddings.ts'
import { createApp } from '../src/index.ts'
import { closeAllSessions } from '../src/tools/mcp-server.ts'

const TEST_PORT = 13192
const BASE_URL = `http://localhost:${TEST_PORT}`
const MCP_URL = `${BASE_URL}/mcp`

const prisma = new PrismaClient()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverApp: any = null

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  // Sin Accept el SDK responde 406
  Accept: 'application/json, text/event-stream',
}

beforeAll(async () => {
  await prisma.$executeRaw`TRUNCATE notes CASCADE`
  console.log('[mcp-sessions.test] Calentando modelo ONNX...')
  await warmup()
  console.log('[mcp-sessions.test] Modelo listo.')

  serverApp = createApp()
  serverApp.listen(TEST_PORT)
}, 15 * 60 * 1000)

afterAll(async () => {
  closeAllSessions()
  serverApp?.stop()
  await prisma.$disconnect()
})

describe('Sesión desconocida responde 404 JSON-RPC', () => {
  test('tools/list con un mcp-session-id inventado → 404 con error.code -32001 e id null', async () => {
    const r = await fetch(MCP_URL, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': 'sesion-que-no-existe' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(r.status).toBe(404)
    expect(r.headers.get('content-type')).toContain('application/json')
    const body = (await r.json()) as {
      jsonrpc: string
      error: { code: number; message: string }
      id: null
    }
    expect(body.jsonrpc).toBe('2.0')
    expect(body.error.code).toBe(-32001)
    expect(body.error.message).toBe('Session not found')
    expect(body.id).toBeNull()
  })

  test('tras initialize, el id nuevo permite tools/list con las 8 tools', async () => {
    // 1. initialize sin id
    const initRes = await fetch(MCP_URL, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'mcp-sessions-test', version: '1.0' },
        },
      }),
    })
    expect(initRes.status).toBe(200)
    const sessionId = initRes.headers.get('mcp-session-id')
    expect(sessionId).toBeTruthy()

    // 2. tools/list con el id nuevo
    const listRes = await fetch(MCP_URL, {
      method: 'POST',
      headers: { ...MCP_HEADERS, 'mcp-session-id': sessionId! },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    })
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as { result: { tools: Array<{ name: string }> } }
    const names = listBody.result.tools.map((t) => t.name).sort()
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
  })
})
