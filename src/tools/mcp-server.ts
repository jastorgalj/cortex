/**
 * src/tools/mcp-server.ts — MCP server con ocho tools, transporte HTTP streamable.
 * Usa WebStandardStreamableHTTPServerTransport (nativo Bun/Web API).
 * Un transport por sesión; session map en memoria.
 */
import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import type { PrismaClient } from '@prisma/client'
import {
  createNote,
  readNote,
  updateNote,
  listNotes,
  countNotesByApp,
  getNoteHistory,
  softDeleteNote,
  ValidationError,
  NotFoundError,
  ConflictError,
} from '../db/notes.ts'
import { hybridSearch } from '../db/search.ts'
import { getAppConfig, GENERAL_APP } from '../db/apps.ts'
import { NOTE_KINDS, NOTE_KIND_DESCRIPTIONS, duplicateThreshold } from '../db/constants.ts'
import { noteWarnings } from '../db/note-quality.ts'
import { SessionRegistry } from './sessions.ts'
import { TOOL_ALIASES, normalizeToolArgs, resolveAuthor } from './args.ts'

/** Versión del paquete: `package.json` es la fuente, no un literal que envejece. */
const PKG_VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version: string }
).version

// ─── Session registry ─────────────────────────────────────────────────────────

const registry = new SessionRegistry()

/**
 * Descripción del campo `kind` compuesta desde `NOTE_KIND_DESCRIPTIONS`: una sola fuente
 * de los tipos y sus significados. El agente elige el tipo sin leer una nota.
 */
const KIND_DESCRIPTION = NOTE_KINDS.map(
  (kind) => `${kind}: ${NOTE_KIND_DESCRIPTIONS[kind]}`,
).join('; ')

/**
 * Descripción del campo `app` compuesta desde el vocabulario configurado: si el server
 * declara `CORTEX_APPS`, el agente ve los valores válidos en vez de adivinarlos.
 */
const APP_DESCRIPTION = (() => {
  const config = getAppConfig()
  if (config.apps.length === 0) {
    return 'App a la que pertenece (cartera, huella, general, ...). Se normaliza a minúsculas; `general` es la app transversal.'
  }
  const valid = [...new Set([...config.apps, GENERAL_APP])].join(', ')
  return `App a la que pertenece — valores válidos: ${valid}. Se normaliza a minúsculas; \`general\` es transversal.`
})()

// ─── Tool registration ────────────────────────────────────────────────────────

/**
 * Serializa la nota agregando `warnings` solo cuando hay algo que advertir: una
 * nota bien formada devuelve exactamente el JSON de siempre (sin campo extra).
 * No bloqueante — la nota ya se creó/actualizó.
 */
function withWarnings(note: object, warnings: string[]): string {
  if (warnings.length === 0) return JSON.stringify(note, null, 2)
  return JSON.stringify({ ...note, warnings }, null, 2)
}

function registerTools(server: McpServer, prisma: PrismaClient): void {
  // ── cortex_search ──────────────────────────────────────────────────────────
  server.tool(
    'cortex_search',
    'Búsqueda híbrida (léxica + semántica con fusión RRF) en Cortex. Devuelve notas ordenadas por relevancia con id, título, snippet, score, origen, app e issue.',
    {
      q: z.string().describe('Términos de búsqueda (lenguaje natural o identificadores exactos)'),
      app: z
        .string()
        .optional()
        .describe(
          'Filtro por app. Incluye por defecto las notas de `general` (transversal); usa include_general: false para excluirlas.',
        ),
      include_general: z
        .boolean()
        .optional()
        .describe('Filtra solo la app pedida, sin las notas de `general` (default true: sí las incluye)'),
      kind: z
        .enum(NOTE_KINDS)
        .optional()
        .describe(`Filtro por tipo de nota — ${KIND_DESCRIPTION}`),
      issue: z.string().optional().describe('Filtro por issue (CAR-123, #134 — sin importar mayúsculas ni espacios)'),
      tags: z.array(z.string()).optional().describe('Filtro por tags (AND: la nota debe tener todos)'),
      limit: z.number().int().min(1).max(50).optional().describe('Máximo de resultados (default 10)'),
    },
    async ({ q, app, include_general, kind, issue, tags, limit }) => {
      try {
        const results = await hybridSearch(
          prisma,
          q,
          { app, include_general, kind, issue, tags },
          limit ?? 10,
        )
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
    'Crea una nueva nota de conocimiento. Si existen notas muy similares (coseno ≥ umbral configurable, o mismo issue con título casi igual), responde con status similar_exists y los candidatos; usa force: true (con reason obligatorio) para crear igualmente. La nota creada puede volver con un campo warnings (no bloqueante) si el contenido parece bitácora o no calza con su kind.',
    {
      title: z.string().describe('Título de la nota'),
      body_md: z.string().describe('Contenido en Markdown'),
      app: z.string().describe(APP_DESCRIPTION),
      kind: z.enum(NOTE_KINDS).describe(`Tipo de nota — ${KIND_DESCRIPTION}`),
      tags: z.array(z.string()).optional().describe('Tags'),
      author: z.string().optional().describe('Autor de la nota (argumento > header x-cortex-author > nombre del cliente MCP > agente; un author inferido no es un author declarado). Obligatorio en cortex_delete.'),
      issue: z
        .string()
        .nullable()
        .optional()
        .describe('Issue relacionado (CAR-123, #134, URL — formato libre); null o vacío guarda null'),
      force: z
        .boolean()
        .optional()
        .describe('Forzar creación aunque existan similares (default false). Exige reason.'),
      reason: z
        .string()
        .optional()
        .describe(
          'Obligatorio con force: true: por qué esta nota no es un duplicado de las candidatas. Queda guardado en la nota.',
        ),
    },
    async ({ title, body_md, app, kind, tags, author, issue, force, reason }, extra) => {
      if (author !== undefined) {
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
      } else {
        const headerRaw = extra?.requestInfo?.headers?.['x-cortex-author']
        author = resolveAuthor({
          header: Array.isArray(headerRaw) ? headerRaw[0] : headerRaw,
          clientName: server.server.getClientVersion()?.name,
        })
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
          reason,
        })
        if (result.status === 'similar_exists') {
          const umbral = duplicateThreshold()
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'similar_exists',
                    message:
                      `Se encontraron notas muy similares (umbral coseno: ${umbral}, o mismo issue con título casi igual). ` +
                      'Para fusionar el contenido nuevo con una nota existente, usa cortex_update sobre el id candidato. ' +
                      'Para crear la nota igualmente (aceptando posible duplicado), reintenta con force: true y reason explicando por qué no es un duplicado.',
                    candidates: result.candidates,
                  },
                  null,
                  2,
                ),
              },
            ],
          }
        }
        // Warnings de dos fuentes: el vocabulario de `app` (capa de datos) y la
        // calidad del contenido (heurísticas). Un solo campo para el agente.
        const warnings = [...result.warnings, ...noteWarnings(result.note)]
        return { content: [{ type: 'text', text: withWarnings(result.note, warnings) }] }
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
      app: z
        .string()
        .optional()
        .describe(`${APP_DESCRIPTION} Omite para no cambiar.`),
      kind: z
        .enum(NOTE_KINDS)
        .optional()
        .describe(`Nuevo tipo de nota, para corregir la clasificación — ${KIND_DESCRIPTION}`),
      issue: z
        .string()
        .nullable()
        .optional()
        .describe('Issue relacionado (omite para no cambiar; null para quitarlo; string vacío es error)'),
      author: z.string().optional().describe('Autor del cambio (argumento > header x-cortex-author > nombre del cliente MCP > agente; un author inferido no es un author declarado). Obligatorio en cortex_delete.'),
      reason: z.string().optional().describe('Motivo del cambio (queda registrado en la revisión)'),
      base_rev: z
        .number()
        .int()
        .optional()
        .describe(
          'Revisión esperada (rev vigente leída antes de editar). Si no coincide con la actual, rechaza con ConflictError.',
        ),
    },
    async ({ id, title, body_md, tags, app, kind, issue, author, reason, base_rev }, extra) => {
      if (author !== undefined) {
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
      } else {
        const headerRaw = extra?.requestInfo?.headers?.['x-cortex-author']
        author = resolveAuthor({
          header: Array.isArray(headerRaw) ? headerRaw[0] : headerRaw,
          clientName: server.server.getClientVersion()?.name,
        })
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
        const note = await updateNote(prisma, id, {
          title,
          body_md,
          tags,
          app,
          kind,
          issue,
          author,
          reason,
          base_rev,
        })
        // `updateNote` puede traer los warnings del vocabulario de `app` en el DTO:
        // se suman a los de calidad del contenido en el mismo campo.
        const warnings = [...(note.warnings ?? []), ...noteWarnings(note)]
        return { content: [{ type: 'text', text: withWarnings(note, warnings) }] }
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
    'Lista notas no borradas con filtros opcionales. Ordenadas por updated_at descendente. No incluye el body_md para mantener la respuesta compacta. Al filtrar por app incluye `general`.',
    {
      app: z
        .string()
        .optional()
        .describe('Filtro por app. Incluye por defecto las notas de `general` (transversal)'),
      include_general: z
        .boolean()
        .optional()
        .describe('Con `app`, lista solo esa app sin las notas de `general` (default true: sí las incluye)'),
      kind: z
        .enum(NOTE_KINDS)
        .optional()
        .describe(`Filtro por tipo — ${KIND_DESCRIPTION}`),
      tags: z.array(z.string()).optional().describe('Filtro por tags (AND: la nota debe tener todos)'),
      author: z.string().optional().describe('Filtro por autor'),
      issue: z.string().optional().describe('Filtro por issue (sin importar mayúsculas ni espacios)'),
    },
    async ({ app, include_general, kind, tags, author, issue }) => {
      try {
        const notes = await listNotes(prisma, { app, include_general, kind, tags, author, issue })
        // Excluye body_md para compactar la respuesta en listados
        const compact = notes.map(({ body_md: _, ...rest }) => rest)
        return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Error en cortex_list: ${msg}` }], isError: true }
      }
    },
  )

  // ── cortex_apps ────────────────────────────────────────────────────────────
  server.tool(
    'cortex_apps',
    'Descubre el vocabulario de apps en uso: cada app con su cantidad de notas no borradas, más la lista canónica configurada. Úsala para clasificar una nota nueva sin inventar un valor.',
    {},
    async () => {
      try {
        const apps = await countNotesByApp(prisma)
        const config = getAppConfig()
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  apps,
                  vocabulary: {
                    canonicas: [...new Set([...config.apps, GENERAL_APP])],
                    modo: config.mode,
                    aliases: config.aliases,
                  },
                },
                null,
                2,
              ),
            },
          ],
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Error en cortex_apps: ${msg}` }], isError: true }
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
              text: JSON.stringify(
                { id: result.id, deleted_at: result.deleted_at, rev: result.rev },
                null,
                2,
              ),
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
      registry.add(sid, transport)
    },
    onsessionclosed: (sid) => {
      registry.delete(sid, 'delete')
    },
  })

  const mcpServer = new McpServer({
    name: 'cortex',
    version: PKG_VERSION,
  })

  registerTools(mcpServer, prisma)
  mcpServer.connect(transport)

  // ── Wrapper de alias: intercepta tools/call antes de delegar al SDK ──────────
  // onmessage ya está asignado de forma síncrona por mcpServer.connect (medido en F0).
  const originalOnmessage = transport.onmessage
  transport.onmessage = (
    msg: Parameters<NonNullable<typeof transport.onmessage>>[0],
    options?: Parameters<NonNullable<typeof transport.onmessage>>[1],
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = msg as any
    const toolName: string | undefined = m.method === 'tools/call' ? m.params?.name : undefined
    if (
      toolName &&
      toolName in TOOL_ALIASES &&
      typeof m.params?.arguments === 'object' &&
      m.params?.arguments !== null
    ) {
      const normResult = normalizeToolArgs(toolName, m.params.arguments as Record<string, unknown>)
      if (!normResult.ok) {
        const text = `Error en ${toolName}: '${normResult.a}' y '${normResult.b}' llegaron con valores distintos; envía solo '${normResult.canonical}'`
        void transport.send(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }], isError: true } } as any,
          { relatedRequestId: m.id },
        )
        return
      }
      originalOnmessage?.(
        { ...msg, params: { ...m.params, arguments: normResult.args } } as typeof msg,
        options,
      )
      return
    }
    originalOnmessage?.(msg, options)
  }

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
    const transport = registry.get(sessionId)
    if (!transport) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        }),
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
  return registry.size
}

/** Cierra todas las sesiones MCP (para el cierre limpio). */
export function closeAllSessions(motivo: 'shutdown' = 'shutdown'): void {
  registry.closeAll(motivo)
}

/** Elimina las sesiones cuyo lastSeen supere el TTL (llamado desde el barrido). */
export function sweepIdleSessions(ttlMs: number): void {
  registry.sweep(Date.now(), ttlMs)
}
