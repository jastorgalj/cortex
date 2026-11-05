/**
 * src/web/views.ts — Vistas HTML de solo lectura.
 * Renderiza markdown con 'marked'. Sin endpoints de escritura.
 */
import { marked } from 'marked'
import type { NoteDto } from '../db/notes.ts'

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title)} — Cortex</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; background: #f9f9f9; }
    header { background: #0a3d62; color: #fff; padding: 1rem 2rem; display: flex; align-items: center; gap: 1rem; }
    header a { color: #fff; text-decoration: none; font-size: 1.1rem; font-weight: 600; }
    main { max-width: 900px; margin: 2rem auto; padding: 0 1.5rem; }
    .tag { display: inline-block; background: #e8f4fd; color: #1565c0; border-radius: 4px; padding: 2px 8px; font-size: 0.75rem; margin-right: 4px; margin-bottom: 4px; }
    .kind { display: inline-block; background: #e8f5e9; color: #2e7d32; border-radius: 4px; padding: 2px 8px; font-size: 0.75rem; margin-right: 8px; }
    .app { display: inline-block; background: #fff3e0; color: #e65100; border-radius: 4px; padding: 2px 8px; font-size: 0.75rem; margin-right: 8px; }
    .meta { color: #666; font-size: 0.85rem; margin: 0.5rem 0 1rem; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    th { background: #f0f4f8; text-align: left; padding: 0.75rem 1rem; font-size: 0.85rem; color: #555; }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid #eee; font-size: 0.9rem; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    td a { color: #1565c0; text-decoration: none; font-weight: 500; }
    td a:hover { text-decoration: underline; }
    .note-body { background: #fff; padding: 2rem; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); line-height: 1.7; }
    .note-body h1, .note-body h2, .note-body h3 { margin: 1.5rem 0 0.5rem; }
    .note-body p { margin: 0.75rem 0; }
    .note-body pre { background: #f4f4f4; padding: 1rem; border-radius: 4px; overflow-x: auto; margin: 1rem 0; }
    .note-body code { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.875em; background: #f4f4f4; padding: 1px 4px; border-radius: 3px; }
    .note-body pre code { background: none; padding: 0; }
    .note-body ul, .note-body ol { padding-left: 1.5rem; margin: 0.5rem 0; }
    .note-body li { margin: 0.25rem 0; }
    .note-body blockquote { border-left: 4px solid #ccc; padding-left: 1rem; color: #666; margin: 1rem 0; }
    .note-header { margin-bottom: 1.5rem; }
    .note-title { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.5rem; }
    .back { display: inline-block; color: #1565c0; text-decoration: none; margin-bottom: 1rem; font-size: 0.9rem; }
    .back::before { content: '← '; }
    .issue { font-size: 0.85rem; color: #666; margin-top: 0.5rem; }
    .deleted-banner { background: #ffebee; border: 1px solid #ef9a9a; border-radius: 6px; padding: 0.75rem 1rem; margin-bottom: 1rem; color: #c62828; }
    .search-bar { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
    .search-bar input { flex: 1; padding: 0.6rem 1rem; border: 1px solid #ccc; border-radius: 6px; font-size: 0.9rem; }
    .search-bar button { padding: 0.6rem 1.2rem; background: #0a3d62; color: #fff; border: none; border-radius: 6px; cursor: pointer; }
    h2 { font-size: 1.3rem; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <header>
    <a href="/">🧠 Cortex</a>
  </header>
  <main>${body}</main>
</body>
</html>`
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

/** GET / — lista de notas */
export function renderNoteList(notes: NoteDto[]): string {
  const rows = notes
    .map(
      (n) => `
    <tr>
      <td><a href="/notes/${escHtml(n.id)}">${escHtml(n.title)}</a></td>
      <td><span class="app">${escHtml(n.app)}</span><span class="kind">${escHtml(n.kind)}</span></td>
      <td>${n.tags.map((t) => `<span class="tag">${escHtml(t)}</span>`).join('')}</td>
      <td>${escHtml(n.author)}</td>
      <td>${formatDate(n.updated_at)}</td>
    </tr>`,
    )
    .join('')

  const body = `
    <form class="search-bar" action="/notes-search" method="get">
      <input name="q" placeholder="Buscar notas…" />
      <button type="submit">Buscar</button>
    </form>
    <h2>${notes.length} nota${notes.length !== 1 ? 's' : ''} (vista de solo lectura — escritura vía MCP)</h2>
    <table>
      <thead><tr>
        <th>Título</th><th>App / Tipo</th><th>Tags</th><th>Autor</th><th>Actualizada</th>
      </tr></thead>
      <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:#999;padding:2rem">Sin notas aún</td></tr>'}</tbody>
    </table>`

  return layout('Cortex', body)
}

/** GET /notes-search — resultado de búsqueda (redirige a API) */
export function renderSearchRedirect(q: string): string {
  return layout(
    'Buscar',
    `<p>Redirigiendo a la búsqueda… <a href="/api/search?q=${encodeURIComponent(q)}">Ver resultados JSON</a></p>
    <script>location.href = '/api/search?q=' + encodeURIComponent(${JSON.stringify(q)})</script>`,
  )
}

/** GET /notes/:id — detalle de una nota con markdown renderizado */
export async function renderNote(note: NoteDto & { is_deleted?: true }): Promise<string> {
  const renderedMd = await marked(note.body_md, { async: true })

  const deletedBanner = note.is_deleted
    ? '<div class="deleted-banner">⚠️ Esta nota está borrada (soft delete). Solo visible directamente por id.</div>'
    : ''

  const issueLine = note.issue
    ? `<div class="issue">Issue: <a href="${note.issue.startsWith('http') ? escHtml(note.issue) : '#'}" target="_blank">${escHtml(note.issue)}</a></div>`
    : ''

  const body = `
    <a href="/" class="back">Volver al listado</a>
    ${deletedBanner}
    <div class="note-header">
      <div class="note-title">${escHtml(note.title)}</div>
      <div>
        <span class="app">${escHtml(note.app)}</span>
        <span class="kind">${escHtml(note.kind)}</span>
        ${note.tags.map((t) => `<span class="tag">${escHtml(t)}</span>`).join('')}
      </div>
      <div class="meta">
        por <strong>${escHtml(note.author)}</strong> ·
        rev ${note.rev} ·
        creada ${formatDate(note.created_at)} ·
        actualizada ${formatDate(note.updated_at)}
      </div>
      ${issueLine}
    </div>
    <div class="note-body">${renderedMd}</div>`

  return layout(note.title, body)
}
