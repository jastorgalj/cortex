/**
 * src/index.ts — Servidor Elysia.
 */
import { Elysia, t } from 'elysia'
import { prisma } from './db/client.ts'
import { listNotes, readNote, NotFoundError } from './db/notes.ts'
import { hybridSearch } from './db/search.ts'
import { isModelLoaded, warmup } from './db/embeddings.ts'
import { handleMcpRequest } from './tools/mcp-server.ts'
import { renderNoteList, renderNote } from './web/views.ts'

export const PORT = Number(process.env.PORT ?? 3091)

export function createApp(): Elysia {
  const app = new Elysia()

  app.get('/health', async () => {
    const count = await prisma.note.count({ where: { deleted_at: null } })
    return { status: 'ok', notes: count, model_loaded: isModelLoaded() }
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
}
