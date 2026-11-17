/**
 * src/index.ts — Servidor Elysia.
 */
import { Elysia, t } from 'elysia'
import { prisma, rawPrisma } from './db/client.ts'
import { listNotes, readNote, NotFoundError } from './db/notes.ts'
import { hybridSearch } from './db/search.ts'
import { isModelLoaded, warmup } from './db/embeddings.ts'
import { handleMcpRequest, getActiveSessions, closeAllSessions, sweepIdleSessions } from './tools/mcp-server.ts'
import { renderNoteList, renderNote } from './web/views.ts'
import { createHealthProbe } from './health.ts'
import { parseSessionTtlMinutes } from './tools/sessions.ts'
import { createShutdown } from './shutdown.ts'

export const PORT = Number(process.env.PORT ?? 3091)

export interface AppOptions {
  /** Función que cuenta notas; default: rawPrisma.note.count sin reintentos. */
  countNotes?: () => Promise<number>
}

export function createApp(opts: AppOptions = {}): Elysia {
  const countNotes = opts.countNotes ?? (() => rawPrisma.note.count({ where: { deleted_at: null } }))
  const probe = createHealthProbe({ countNotes })

  const app = new Elysia()

  app.get('/health', async ({ set }) => {
    const result = await probe()
    const sessions = getActiveSessions()
    const uptime_s = Math.floor(process.uptime())

    if (result.ok) {
      return {
        status: 'ok',
        notes: result.notes,
        model_loaded: isModelLoaded(),
        sessions,
        uptime_s,
      }
    } else {
      set.status = 503
      return {
        status: 'degraded',
        db: 'down',
        model_loaded: isModelLoaded(),
        sessions,
        uptime_s,
        error: 'base de datos no disponible',
      }
    }
  })

  app.all('/mcp', ({ request }) => handleMcpRequest(request, prisma))

  app.get(
    '/api/search',
    async ({ query }) => {
      const { q, app: appFilter, kind, limit } = query
      if (!q) return { error: "El parametro 'q' es requerido" }
      return hybridSearch(prisma, q, { app: appFilter, kind }, Number(limit) || 10)
    },
    {
      query: t.Object({
        q: t.Optional(t.String()),
        app: t.Optional(t.String()),
        kind: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )

  app.get('/api/notes/:id', async ({ params: { id }, set }) => {
    try {
      return await readNote(prisma, id)
    } catch (err) {
      if (err instanceof NotFoundError) {
        set.status = 404
        return { error: `Nota '${id}' no encontrada` }
      }
      throw err
    }
  })

  app.post('/api/*', ({ set }) => { set.status = 405; return { error: 'Escritura no permitida. Usa /mcp.' } })
  app.put('/api/*', ({ set }) => { set.status = 405; return { error: 'Escritura no permitida. Usa /mcp.' } })
  app.patch('/api/*', ({ set }) => { set.status = 405; return { error: 'Escritura no permitida. Usa /mcp.' } })
  app.delete('/api/*', ({ set }) => { set.status = 405; return { error: 'Escritura no permitida. Usa /mcp.' } })

  app.get('/', async ({ set }) => {
    const notes = await listNotes(prisma)
    set.headers['Content-Type'] = 'text/html; charset=utf-8'
    return renderNoteList(notes)
  })

  app.get('/notes/:id', async ({ params: { id }, set }) => {
    try {
      const note = await readNote(prisma, id)
      set.headers['Content-Type'] = 'text/html; charset=utf-8'
      return await renderNote(note)
    } catch (err) {
      if (err instanceof NotFoundError) {
        set.status = 404
        set.headers['Content-Type'] = 'text/html; charset=utf-8'
        return '<!DOCTYPE html><html><body><h1>Nota no encontrada</h1><p><a href="/">Volver</a></p></body></html>'
      }
      throw err
    }
  })

  app.post('/notes/:id', ({ set }) => { set.status = 405; return { error: 'Solo lectura' } })
  app.put('/notes/:id', ({ set }) => { set.status = 405; return { error: 'Solo lectura' } })
  app.patch('/notes/:id', ({ set }) => { set.status = 405; return { error: 'Solo lectura' } })
  app.delete('/notes/:id', ({ set }) => { set.status = 405; return { error: 'Solo lectura' } })
  app.post('/', ({ set }) => { set.status = 405; return { error: 'Solo lectura' } })
  app.put('/', ({ set }) => { set.status = 405; return { error: 'Solo lectura' } })
  app.patch('/', ({ set }) => { set.status = 405; return { error: 'Solo lectura' } })
  app.delete('/', ({ set }) => { set.status = 405; return { error: 'Solo lectura' } })

  app.all('*', ({ request, set }) => {
    const url = new URL(request.url)
    set.status = 404
    return { statusCode: 404, message: `Ruta no encontrada: ${request.method} ${url.pathname}` }
  })

  return app
}

if (import.meta.main) {
  console.log('[cortex] Calentando modelo ONNX (warmup)...')
  await warmup()
  console.log('[cortex] Modelo listo. Iniciando servidor en :' + PORT)

  const app = createApp()
  app.listen(PORT, () => {
    console.log(`[cortex] Servidor escuchando en http://localhost:${PORT}`)
  })

  const ttlMs = parseSessionTtlMinutes(process.env.MCP_SESSION_TTL_MINUTES) * 60 * 1000
  const sweepInterval = setInterval(() => sweepIdleSessions(ttlMs), 60_000)
  sweepInterval.unref()

  const shutdown = createShutdown({
    closeSessions: closeAllSessions,
    stopServer: async () => {
      await app.stop()
    },
    disconnect: () => rawPrisma.$disconnect(),
  })

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('uncaughtException', async (err) => {
    console.error('[cortex] Excepción no capturada:', err.stack)
    await shutdown('uncaughtException', 1)
  })
  process.on('unhandledRejection', async (reason) => {
    const e = reason instanceof Error ? reason : new Error(String(reason))
    console.error('[cortex] Promesa rechazada sin manejar:', e.stack)
    await shutdown('unhandledRejection', 1)
  })
}
