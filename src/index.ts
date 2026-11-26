/**
 * src/index.ts — Servidor Elysia.
 */
import { Elysia, t } from 'elysia'
import { prisma, rawPrisma, idleDisconnect, closeDb } from './db/client.ts'
import { listNotes, readNote, countNotesByApp, NotFoundError } from './db/notes.ts'
import { hybridSearch } from './db/search.ts'
import { getAppConfig, GENERAL_APP } from './db/apps.ts'
import { isModelLoaded, warmup } from './db/embeddings.ts'
import { handleMcpRequest, getActiveSessions, closeAllSessions, sweepIdleSessions } from './tools/mcp-server.ts'
import { renderNoteList, renderNote } from './web/views.ts'
import { createHealthProbe } from './health.ts'
import { parseSessionTtlMinutes } from './tools/sessions.ts'
import { createShutdown } from './shutdown.ts'
import { duplicateThreshold } from './db/constants.ts'

export const PORT = Number(process.env.PORT ?? 3091)

export interface AppOptions {
  /** Función que cuenta notas; default: rawPrisma.note.count sin reintentos. */
  countNotes?: () => Promise<number>
  /** Función que indica si el pool está inactivo; default: idleDisconnect.isIdle(). */
  isPoolIdle?: () => boolean
}

export function createApp(opts: AppOptions = {}): Elysia {
  const countNotes = opts.countNotes ?? (() => rawPrisma.note.count({ where: { deleted_at: null } }))
  const isPoolIdle = opts.isPoolIdle ?? (() => idleDisconnect.isIdle())
  const probe = createHealthProbe({ countNotes })

  const app = new Elysia()

  app.get('/health', async ({ set }) => {
    if (isPoolIdle()) {
      return {
        status: 'ok',
        db_pool: 'idle',
        model_loaded: isModelLoaded(),
        sessions: getActiveSessions(),
        uptime_s: Math.floor(process.uptime()),
      }
    }

    const result = await probe()
    const sessions = getActiveSessions()
    const uptime_s = Math.floor(process.uptime())

    if (result.ok) {
      return {
        status: 'ok',
        notes: result.notes,
        db_pool: 'active',
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
      const { q, app: appFilter, kind, limit, issue, tags: tagsStr, include_general } = query
      if (!q) return { error: "El parametro 'q' es requerido" }
      // tags=a,b,c → array sin vacíos
      const tags = tagsStr
        ? tagsStr.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
        : undefined
      return hybridSearch(
        prisma,
        q,
        {
          app: appFilter,
          // `include_general=false` es el único valor que excluye la app transversal.
          include_general: include_general === undefined ? undefined : include_general !== 'false',
          kind,
          issue,
          tags,
        },
        Number(limit) || 10,
      )
    },
    {
      query: t.Object({
        q: t.Optional(t.String()),
        app: t.Optional(t.String()),
        include_general: t.Optional(t.String()),
        kind: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        issue: t.Optional(t.String()),
        tags: t.Optional(t.String()),
      }),
    },
  )

  /** Descubrimiento del vocabulario: apps en uso con su conteo + lista canónica. */
  app.get('/api/apps', async () => {
    const config = getAppConfig()
    return {
      apps: await countNotesByApp(prisma),
      vocabulary: {
        canonicas: [...new Set([...config.apps, GENERAL_APP])],
        modo: config.mode,
        aliases: config.aliases,
      },
    }
  })

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
  const threshold = duplicateThreshold()
  console.log('[cortex] Umbral de duplicados: ' + threshold)
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
    disconnect: closeDb,
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
