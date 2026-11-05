/**
 * src/tools/mcp-server.ts — MCP server con siete tools, transporte HTTP streamable.
 * Usa WebStandardStreamableHTTPServerTransport (nativo Bun/Web API).
 * Un transport por sesión; session map en memoria.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import type { PrismaClient } from '@prisma/client'
import {
  createNote,
  readNote,
  updateNote,
  listNotes,
  getNoteHistory,
  softDeleteNote,
  ValidationError,
  NotFoundError,
  ConflictError,
} from '../db/notes.ts'
import { hybridSearch } from '../db/search.ts'

// ─── Session registry ─────────────────────────────────────────────────────────

const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()

// ─── Tool registration ────────────────────────────────────────────────────────

function registerTools(server: McpServer, prisma: PrismaClient): void {
  // ── cortex_search ──────────────────────────────────────────────────────────
  server.tool(
    'cortex_search',
    'Búsqueda híbrida (léxica + semántica con fusión RRF) en Cortex. Devuelve notas ordenadas por relevancia con id, título, snippet, score y origen.',
    {
      q: z.string().describe('Términos de búsqueda (lenguaje natural o identificadores exactos)'),
      app: z.string().optional().describe('Filtro por app (cartera, huella, general, ...)'),
      kind: z
        .enum(['sistema', 'flujo', 'decision', 'pitfall', 'regla', 'otro'])
        .optional()
        .describe('Filtro por tipo de nota'),
      limit: z.number().int().min(1).max(50).optional().describe('Máximo de resultados (default 10)'),
    },
    async ({ q, app, kind, limit }) => {
      try {
        const results = await hybridSearch(prisma, q, { app, kind }, limit ?? 10)
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Error en cortex_search: ${msg}` }], isError: true }
      }
    },
  )

  // ── cortex_read ────────────────────────────────────────────────────────────
  server.tool(
    'cortex_read',
    'Lee una nota por su id (ULID). Devuelve la nota completa incluyendo cuerpo en markdown y metadatos.',
    {
      id: z.string().describe('Id de la nota (ULID de 26 caracteres)'),
    },
    async ({ id }) => {
      if (!id?.trim()) {
        return {
          content: [{ type: 'text', text: "Error en cortex_read: el parámetro 'id' es requerido" }],
          isError: true,
        }
      }
      try {
        const note = await readNote(prisma, id)
        return { content: [{ type: 'text', text: JSON.stringify(note, null, 2) }] }
      } catch (err) {
        if (err instanceof NotFoundError) {
          return {
            content: [{ type: 'text', text: `Error en cortex_read: nota '${id}' no encontrada` }],
            isError: true,
          }
        }
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Error en cortex_read: ${msg}` }], isError: true }
      }
    },
  )

  // ── cortex_write ───────────────────────────────────────────────────────────
  server.tool(
    'cortex_write',
    'Crea una nueva nota de conocimiento. Si existen notas muy similares (similitud ≥ 0.55), responde con status similar_exists y los candidatos; usa force: true para crear igualmente.',
    {
      title: z.string().describe('Título de la nota'),
      body_md: z.string().describe('Contenido en Markdown'),
      app: z.string().describe("App a la que pertenece (cartera, huella, general, ...)"),
      kind: z
        .enum(['sistema', 'flujo', 'decision', 'pitfall', 'regla', 'otro'])
        .describe('Tipo de nota'),
      tags: z.array(z.string()).optional().describe('Tags'),
      author: z.string().describe('Autor de la nota (requerido; se persiste tal cual)'),
      issue: z
        .string()
        .optional()
        .describe('Issue relacionado (CAR-123, #134, URL — formato libre)'),
      force: z
        .boolean()
        .optional()
        .describe('Forzar creación aunque existan similares (default false)'),
    },
    async ({ title, body_md, app, kind, tags, author, issue, force }) => {
      if (!author?.trim()) {
        return {
          content: [
            {
              type: 'text',
              text: "Error en cortex_write: el parámetro 'author' es requerido y no puede estar vacío",
            },
          ],
          isError: true,
        }
      }
      try {
        const result = await createNote(prisma, {
          title,
          body_md,
          app,
          kind,
          tags,
          author,
          issue,
          force,
        })
        if (result.status === 'similar_exists') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'similar_exists',
                    message:
                      'Se encontraron notas muy similares (similitud ≥ 0.55). ' +
                      'Para fusionar el contenido nuevo con una nota existente, usa cortex_update sobre el id candidato. ' +
                      'Para crear la nota igualmente (aceptando posible duplicado), reintenta con force: true.',
                    candidates: result.candidates,
                  },
                  null,
                  2,
                ),
              },
            ],
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(result.note, null, 2) }] }
      } catch (err) {
        if (err instanceof ValidationError) {
          return {
            content: [
              {
                type: 'text',
                text: `Error en cortex_write: parámetro inválido '${err.field}' — ${err.message}`,
              },
            ],
            isError: true,
          }
        }
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Error en cortex_write: ${msg}` }], isError: true }
      }
    },
  )

  // ── cortex_update ──────────────────────────────────────────────────────────
  server.tool(
    'cortex_update',
    'Actualiza una nota existente. Inserta la versión anterior en el historial de revisiones antes de modificar. Acepta base_rev para control optimista de concurrencia.',
    {
      id: z.string().describe('Id de la nota a actualizar (ULID)'),
      title: z.string().optional().describe('Nuevo título (omite para no cambiar)'),
      body_md: z.string().optional().describe('Nuevo contenido en Markdown (omite para no cambiar)'),
      tags: z.array(z.string()).optional().describe('Nuevos tags (reemplaza los existentes)'),
      author: z.string().describe('Autor del cambio (requerido)'),
      reason: z.string().optional().describe('Motivo del cambio (queda registrado en la revisión)'),
      base_rev: z
        .number()
        .int()
        .optional()
        .describe(
          'Revisión esperada (rev vigente leída antes de editar). Si no coincide con la actual, rechaza con ConflictError.',
        ),
    },
    async ({ id, title, body_md, tags, author, reason, base_rev }) => {
      if (!author?.trim()) {
        return {
          content: [
            {
              type: 'text',
              text: "Error en cortex_update: el parámetro 'author' es requerido y no puede estar vacío",
            },
          ],
          isError: true,
        }
      }
      if (!id?.trim()) {
        return {
          content: [
            { type: 'text', text: "Error en cortex_update: el parámetro 'id' es requerido" },
          ],
          isError: true,
        }
      }
      try {
        const note = await updateNote(prisma, id, { title, body_md, tags, author, reason, base_rev })
        return { content: [{ type: 'text', text: JSON.stringify(note, null, 2) }] }
      } catch (err) {
        if (err instanceof NotFoundError) {
          return {
            content: [{ type: 'text', text: `Error en cortex_update: nota '${id}' no encontrada` }],
            isError: true,
          }
        }
        if (err instanceof ConflictError) {
          return {
            content: [
              {
                type: 'text',
                text: `Error en cortex_update: conflicto de revisión — ${err.message}. Lee la nota de nuevo con cortex_read para obtener la rev vigente (${err.current_rev}) antes de reintentar.`,
              },
            ],
            isError: true,
          }
        }
        if (err instanceof ValidationError) {
          return {
            content: [
              {
                type: 'text',
                text: `Error en cortex_update: parámetro inválido '${err.field}' — ${err.message}`,
              },
            ],
            isError: true,
          }
        }
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Error en cortex_update: ${msg}` }], isError: true }
      }
    },
  )

  // ── cortex_list ────────────────────────────────────────────────────────────
  server.tool(
    'cortex_list',
    'Lista notas no borradas con filtros opcionales. Ordenadas por updated_at descendente. No incluye el body_md para mantener la respuesta compacta.',
    {
      app: z.string().optional().describe('Filtro por app'),
      kind: z
        .enum(['sistema', 'flujo', 'decision', 'pitfall', 'regla', 'otro'])
        .optional()
        .describe('Filtro por tipo'),
      tags: z.array(z.string()).optional().describe('Filtro por tags (AND: la nota debe tener todos)'),
      author: z.string().optional().describe('Filtro por autor'),
    },
    async ({ app, kind, tags, author }) => {
      try {
        const notes = await listNotes(prisma, { app, kind, tags, author })
        // Excluye body_md para compactar la respuesta en listados
        const compact = notes.map(({ body_md: _, ...rest }) => rest)
        return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Error en cortex_list: ${msg}` }], isError: true }
      }
    },
  )

  // ── cortex_history ─────────────────────────────────────────────────────────
  server.tool(
    'cortex_history',
    'Obtiene el historial completo de revisiones de una nota (todas las versiones anteriores a la vigente, ordenadas por rev asc).',
    {
      id: z.string().describe('Id de la nota (ULID)'),
    },
    async ({ id }) => {
      if (!id?.trim()) {
        return {
          content: [{ type: 'text', text: "Error en cortex_history: el parámetro 'id' es requerido" }],
          isError: true,
        }
      }
      try {
        const history = await getNoteHistory(prisma, id)
        return { content: [{ type: 'text', text: JSON.stringify(history, null, 2) }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Error en cortex_history: ${msg}` }], isError: true }
      }
    },
  )

  // ── cortex_delete ──────────────────────────────────────────────────────────
  server.tool(
    'cortex_delete',
    'Borrar una nota (borrado lógico). Exige author y reason no vacíos; la operación queda registrada como la última revisión en el historial.',
    {
      id: z.string().describe('Id de la nota a borrar (ULID)'),
      author: z.string().describe('Autor del borrado (requerido y no puede estar vacío)'),
      reason: z.string().describe('Motivo del borrado (requerido y no puede estar vacío)'),
    },
    async ({ id, author, reason }) => {
      if (!author?.trim()) {
        return {
          content: [
            {
              type: 'text',
              text: "Error en cortex_delete: el parámetro 'author' es requerido y no puede estar vacío",
            },
          ],
          isError: true,
        }
      }
      if (!reason?.trim()) {
        return {
          content: [
            {
              type: 'text',
              text: "Error en cortex_delete: el parámetro 'reason' es requerido y no puede estar vacío",
            },
          ],
          isError: true,
        }
      }
      if (!id?.trim()) {
        return {
          content: [
            { type: 'text', text: "Error en cortex_delete: el parámetro 'id' es requerido" },
          ],
          isError: true,
        }
      }
      try {
        const result = await softDeleteNote(prisma, id, author, reason)
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ id: result.id, deleted_at: result.deleted_at }, null, 2),
            },
          ],
        }
      } catch (err) {
        if (err instanceof NotFoundError) {
          return {
            content: [{ type: 'text', text: `Error en cortex_delete: ${err.message}` }],
            isError: true,
          }
        }
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Error en cortex_delete: ${msg}` }], isError: true }
      }
    },
  )
}

// ─── Session factory ──────────────────────────────────────────────────────────

function createSession(prisma: PrismaClient): WebStandardStreamableHTTPServerTransport {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sid) => {
      sessions.set(sid, transport)
    },
    onsessionclosed: (sid) => {
      sessions.delete(sid)
    },
  })

  const mcpServer = new McpServer({
    name: 'cortex',
    version: '0.2.0',
  })

  registerTools(mcpServer, prisma)
  mcpServer.connect(transport)

  return transport
}

// ─── Main handler ─────────────────────────────────────────────────────────────

/**
 * Maneja una request MCP. Para /mcp con session ID → reutiliza la sesión.
 * Para /mcp sin session ID con initialize → crea sesión nueva.
 */
export async function handleMcpRequest(
  request: Request,
  prisma: PrismaClient,
): Promise<Response> {
  const sessionId = request.headers.get('mcp-session-id')

  if (sessionId) {
    const transport = sessions.get(sessionId)
    if (!transport) {
      return new Response(
        JSON.stringify({ error: `Sesión '${sessionId}' no encontrada o expirada. Reconecta enviando initialize sin mcp-session-id.` }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return transport.handleRequest(request)
  }

  // Sin session ID: solo se acepta initialize (para crear nueva sesión)
  // Para otros métodos (GET SSE sin sesión, DELETE), también se manda al nuevo transport
  // ya que la spec dice que requests sin session en modo stateful deben ser initialize
  const method = request.method.toUpperCase()

  if (method === 'POST') {
    // Leer body para detectar si es initialize
    const bodyText = await request.text()
    let isInitialize = false
    try {
      const body = JSON.parse(bodyText)
      isInitialize = body?.method === 'initialize'
    } catch {
      // body inválido — el transport lo rechazará
    }

    if (!isInitialize) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: "Falta el header 'mcp-session-id'. Envía initialize primero para obtener una sesión.",
          },
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    // Reconstruye la request con el body ya consumido
    const newRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: bodyText,
    })

    const newTransport = createSession(prisma)
    return newTransport.handleRequest(newRequest)
  }

  // GET sin session ID → 400 (el cliente debería conectarse primero)
  if (method === 'GET') {
    return new Response(
      JSON.stringify({ error: "Falta el header 'mcp-session-id'. Inicializa la sesión primero." }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

  return new Response(null, { status: 405 })
}

/** Devuelve el número de sesiones MCP activas (para /health). */
export function getActiveSessions(): number {
  return sessions.size
}
