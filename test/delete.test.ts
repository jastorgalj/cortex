/**
 * test/delete.test.ts — Tests de cortex_delete.
 *
 * Cubre (spec notas):
 *   - Borrado sin autor o sin motivo rechazado (2 variantes)
 *   - El borrado deja rastro en el historial (3 revisions, números 1/2/3 sin repetir)
 *   - Borrar una nota inexistente → error descriptivo, sin revisión creada
 *   - Borrar una nota ya borrada → error descriptivo, sin revisión creada
 *
 * Y (spec servidor-mcp):
 *   - Ciclo completo por MCP con borrado (write→update→delete→list/search/read)
 *   - Los mensajes de error usan los nombres nuevos (cortex_delete)
 *
 * Aserciones incondicionales. Sin try/catch que absorba fallos.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { warmup } from '../src/db/embeddings.ts'
import { createApp } from '../src/index.ts'
import { softDeleteNote, ValidationError } from '../src/db/notes.ts'

const TEST_PORT = 13093
const BASE_URL = `http://localhost:${TEST_PORT}`
const MCP_URL = new URL(`${BASE_URL}/mcp`)

const prisma = new PrismaClient()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let serverApp: any = null

beforeAll(async () => {
  await prisma.$executeRaw`TRUNCATE notes CASCADE`

  console.log('[delete.test] Calentando modelo ONNX...')
  await warmup()
  console.log('[delete.test] Modelo listo.')

  serverApp = createApp()
  serverApp.listen(TEST_PORT)
  console.log(`[delete.test] Servidor escuchando en ${BASE_URL}`)
}, 15 * 60 * 1000)

afterAll(async () => {
  serverApp?.stop()
  await prisma.$disconnect()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClient(): Client {
  return new Client({ name: 'delete-test-client', version: '1.0' })
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

function getErrorText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>
  return content.find((c) => c.type === 'text')?.text ?? ''
}

/** Crea una nota de prueba y devuelve su id. */
async function createTestNote(client: Client, suffix = ''): Promise<string> {
  const result = await client.callTool({
    name: 'cortex_write',
    arguments: {
      title: `Nota de prueba delete${suffix}`,
      body_md: 'Contenido de prueba para borrado lógico. Incluye detalles relevantes.',
      app: 'general',
      kind: 'pitfall',
      tags: ['test-delete'],
      author: 'delete-test',
    },
  })
  const data = parseToolResult(result) as { id: string; status?: string }
  // Si similar_exists (por re-ejecución de tests), reintenta con force
  if ((data as any).status === 'similar_exists') {
    const forced = await client.callTool({
      name: 'cortex_write',
      arguments: {
        title: `Nota de prueba delete${suffix}`,
        body_md: 'Contenido de prueba para borrado lógico. Incluye detalles relevantes.',
        app: 'general',
        kind: 'pitfall',
        tags: ['test-delete'],
        author: 'delete-test',
        force: true,
      },
    })
    const fd = parseToolResult(forced) as { id: string }
    return fd.id
  }
  return (data as { id: string }).id
}

// ─── Tests — parámetros vacíos ────────────────────────────────────────────────

describe('cortex_delete — validación de parámetros', () => {
  test('author vacío → error que nombra el parámetro, nota sigue en cortex_list', async () => {
    const client = makeClient()
    await connectClient(client)

    const noteId = await createTestNote(client, '-author-vacio')

    const result = await client.callTool({
      name: 'cortex_delete',
      arguments: { id: noteId, author: '', reason: 'razón válida' },
    })

    // isError debe ser true
    expect((result as { isError?: boolean }).isError).toBe(true)
    // El mensaje debe nombrar el parámetro 'author'
    const text = getErrorText(result)
    expect(text).toContain('cortex_delete')
    expect(text).toContain("'author'")

    // La nota sigue en cortex_list (no fue borrada)
    const listResult = await client.callTool({ name: 'cortex_list', arguments: {} })
    const listData = parseToolResult(listResult) as Array<{ id: string }>
    expect(listData.map((n) => n.id)).toContain(noteId)

    // El historial no cambió (sigue vacío — solo se creó, no se editó)
    const histResult = await client.callTool({ name: 'cortex_history', arguments: { id: noteId } })
    const histData = parseToolResult(histResult) as Array<unknown>
    expect(histData.length).toBe(0)

    await client.close()
  })

  test('reason vacío → error que nombra el parámetro, nota sigue en cortex_list', async () => {
    const client = makeClient()
    await connectClient(client)

    const noteId = await createTestNote(client, '-reason-vacio')

    const result = await client.callTool({
      name: 'cortex_delete',
      arguments: { id: noteId, author: 'tester', reason: '' },
    })

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = getErrorText(result)
    expect(text).toContain('cortex_delete')
    expect(text).toContain("'reason'")

    // La nota sigue en cortex_list
    const listResult = await client.callTool({ name: 'cortex_list', arguments: {} })
    const listData = parseToolResult(listResult) as Array<{ id: string }>
    expect(listData.map((n) => n.id)).toContain(noteId)

    // Historial sin cambios
    const histResult = await client.callTool({ name: 'cortex_history', arguments: { id: noteId } })
    const histData = parseToolResult(histResult) as Array<unknown>
    expect(histData.length).toBe(0)

    await client.close()
  })
})

// ─── Tests — borrado exitoso y rastro en historial ────────────────────────────

describe('cortex_delete — borrado lógico con rastro en historial', () => {
  test('nota con 2 revisiones → history tiene 3 revs, la última conserva el autor del contenido y registra a quien borró', async () => {
    const client = makeClient()
    await connectClient(client)

    // Crear nota (rev=1)
    const noteId = await createTestNote(client, '-hist')

    // Primera actualización → rev=2 (revision 1 queda en historial)
    await client.callTool({
      name: 'cortex_update',
      arguments: {
        id: noteId,
        body_md: 'Contenido actualizado primera vez. Más detalles del pitfall.',
        author: 'editor-uno',
        reason: 'primera actualización',
        base_rev: 1,
      },
    })

    // Segunda actualización → rev=3 (revision 2 queda en historial)
    await client.callTool({
      name: 'cortex_update',
      arguments: {
        id: noteId,
        body_md: 'Contenido actualizado segunda vez. Estado final antes del borrado.',
        author: 'editor-dos',
        reason: 'segunda actualización',
        base_rev: 2,
      },
    })

    // Verificación previa: 2 revisiones en history
    const histPre = await client.callTool({ name: 'cortex_history', arguments: { id: noteId } })
    const histPreData = parseToolResult(histPre) as Array<{ rev: number }>
    expect(histPreData.length).toBe(2)

    // Borrar con author=maria, reason=duplicada de otra nota
    const deleteResult = await client.callTool({
      name: 'cortex_delete',
      arguments: { id: noteId, author: 'maria', reason: 'duplicada de otra nota' },
    })
    expect((deleteResult as { isError?: boolean }).isError).toBeFalsy()
    const deleteData = parseToolResult(deleteResult) as { id: string; deleted_at: string; rev: number }
    expect(deleteData.id).toBe(noteId)
    expect(deleteData.deleted_at).toBeTruthy()
    // La respuesta informa la revisión en que quedó la nota borrada (3 + 1)
    expect(deleteData.rev).toBe(4)

    // cortex_history devuelve 3 revisiones con números 1, 2, 3 sin repetir
    const histPost = await client.callTool({ name: 'cortex_history', arguments: { id: noteId } })
    const histPostData = parseToolResult(histPost) as Array<{ rev: number; author: string; reason: string | null; body_md: string }>
    expect(histPostData.length).toBe(3)

    const revNums = histPostData.map((r) => r.rev)
    expect(revNums).toEqual([1, 2, 3]) // sin repetir, ascendente

    // La última revisión (rev=3) conserva el autor del contenido vigente (editor-dos),
    // no el de quien borró; y el reason incluye el motivo recibido y a quien borró.
    const lastRev = histPostData[2]!
    expect(lastRev.author).toBe('editor-dos')
    expect(lastRev.reason).toContain('duplicada de otra nota')
    expect(lastRev.reason).toContain('maria')
    // Y el body_md que tenía la nota antes del borrado
    expect(lastRev.body_md).toContain('Estado final antes del borrado')

    // La nota NO aparece en cortex_list
    const listResult = await client.callTool({ name: 'cortex_list', arguments: {} })
    const listData = parseToolResult(listResult) as Array<{ id: string }>
    expect(listData.map((n) => n.id)).not.toContain(noteId)

    // cortex_search no la devuelve
    const searchResult = await client.callTool({
      name: 'cortex_search',
      arguments: { q: 'Estado final antes del borrado', limit: 10 },
    })
    const searchData = parseToolResult(searchResult) as Array<{ id: string }>
    expect(searchData.map((r) => r.id)).not.toContain(noteId)

    // cortex_read la indica borrada (is_deleted: true)
    const readResult = await client.callTool({ name: 'cortex_read', arguments: { id: noteId } })
    const readData = parseToolResult(readResult) as { id: string; is_deleted?: boolean }
    expect(readData.id).toBe(noteId)
    expect(readData.is_deleted).toBe(true)

    await client.close()
  })
})

// ─── Tests — id inexistente o ya borrado ──────────────────────────────────────

describe('cortex_delete — id inexistente o ya borrado', () => {
  test('id inexistente → error descriptivo con el id, sin revisión creada', async () => {
    const client = makeClient()
    await connectClient(client)

    const fakeId = '01JZZZZZZZZZZZZZZZZZZZZZZZ'

    const result = await client.callTool({
      name: 'cortex_delete',
      arguments: { id: fakeId, author: 'tester', reason: 'borrado de prueba' },
    })

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = getErrorText(result)
    expect(text).toContain('cortex_delete')
    expect(text).toContain(fakeId)

    // No se creó ninguna revisión con ese id
    const histResult = await client.callTool({ name: 'cortex_history', arguments: { id: fakeId } })
    const histData = parseToolResult(histResult) as Array<unknown>
    expect(histData.length).toBe(0)

    await client.close()
  })

  test('id ya borrado → error descriptivo con el id, sin revisión adicional', async () => {
    const client = makeClient()
    await connectClient(client)

    // Crea y borra una nota
    const noteId = await createTestNote(client, '-ya-borrado')
    await client.callTool({
      name: 'cortex_delete',
      arguments: { id: noteId, author: 'primer-borrador', reason: 'primer borrado' },
    })

    // Verifica que hay 1 revisión (la del borrado)
    const histPre = await client.callTool({ name: 'cortex_history', arguments: { id: noteId } })
    const histPreData = parseToolResult(histPre) as Array<unknown>
    expect(histPreData.length).toBe(1)

    // Intenta borrar de nuevo
    const result = await client.callTool({
      name: 'cortex_delete',
      arguments: { id: noteId, author: 'segundo-borrador', reason: 'segundo borrado' },
    })

    expect((result as { isError?: boolean }).isError).toBe(true)
    const text = getErrorText(result)
    expect(text).toContain('cortex_delete')
    expect(text).toContain(noteId)

    // El historial no creció — sigue con 1 revisión (no se agregó una segunda)
    const histPost = await client.callTool({ name: 'cortex_history', arguments: { id: noteId } })
    const histPostData = parseToolResult(histPost) as Array<unknown>
    expect(histPostData.length).toBe(1)

    await client.close()
  })
})

// ─── Tests — validación en la capa de datos ───────────────────────────────────

describe('softDeleteNote — validación en la capa de datos (sin la tool)', () => {
  test('author vacío o en blanco → ValidationError que nombra el campo, nota sigue en cortex_list', async () => {
    const client = makeClient()
    await connectClient(client)

    const noteId = await createTestNote(client, '-db-validation')

    for (const author of ['', '   ']) {
      const caught = await softDeleteNote(prisma, noteId, author, 'motivo válido').then(
        () => null,
        (err: unknown) => err,
      )
      expect(caught).toBeInstanceOf(ValidationError)
      expect((caught as ValidationError).field).toBe('author')
    }

    // Sin `reason` tampoco se borra
    for (const reason of ['', '   ']) {
      const caught = await softDeleteNote(prisma, noteId, 'tester', reason).then(
        () => null,
        (err: unknown) => err,
      )
      expect(caught).toBeInstanceOf(ValidationError)
      expect((caught as ValidationError).field).toBe('reason')
    }

    // La nota sigue visible en cortex_list y sin revisión de borrado
    const listResult = await client.callTool({ name: 'cortex_list', arguments: {} })
    const listData = parseToolResult(listResult) as Array<{ id: string }>
    expect(listData.map((n) => n.id)).toContain(noteId)

    const histResult = await client.callTool({ name: 'cortex_history', arguments: { id: noteId } })
    expect((parseToolResult(histResult) as Array<unknown>).length).toBe(0)

    await client.close()
  })
})

// ─── Tests — mensajes de error usan nombres nuevos ───────────────────────────

describe('cortex_delete — mensajes de error usan nombres nuevos', () => {
  test('error de cortex_delete nombra cortex_delete y no usa el prefijo antiguo', async () => {
    const client = makeClient()
    await connectClient(client)

    const result = await client.callTool({
      name: 'cortex_delete',
      arguments: { id: '01JAAAAAAAAAAAAAAAAAAAAAAA', author: 'tester', reason: 'prueba' },
    })

    const text = getErrorText(result)
    expect(text).toContain('cortex_delete')
    // El prefijo antiguo no debe aparecer: verificamos que el texto empieza con el nuevo
    expect(text).toMatch(/^Error en cortex_delete/)

    await client.close()
  })
})
