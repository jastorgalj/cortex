#!/usr/bin/env bun
/**
 * src/import.ts — Importador idempotente de notas desde repos existentes.
 *
 * Uso:
 *   bun run import -- <ruta>
 *
 * Formas de fuente:
 *   (a) Clon de novara-knowledge:
 *       Recorre sistemas/**\/*.md + .bitacora/learnings/*.md
 *       - Excluye frontmatter con status: superseded / estado: superseded
 *       - app inferida: sistemas/cartera/** -> cartera; resto -> general
 *       - kind: sistemas/** -> sistema; learnings -> pitfall|decision del frontmatter (default pitfall)
 *
 *   (b) Repo de codigo con .bitacora/learnings/:
 *       Recorre solo .bitacora/learnings/*.md
 *       - app inferida del nombre del repo (basename de la ruta)
 *       - kind: pitfall|decision del frontmatter (default pitfall)
 *
 *   En ambos casos:
 *   - author: frontmatter.author (o autor del ultimo commit git del archivo, o 'importador')
 *   - issue: frontmatter.issue (si existe)
 *   - tag idempotencia: origen:<repo>:<path-relativo>
 *   - Segunda corrida sobre los mismos archivos no duplica (salteados por el tag)
 *
 * Reporte al final: notas creadas / saltadas / errores por fuente.
 */
import { join, relative, resolve, basename, dirname } from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'
import { parse as parseYaml } from 'yaml'
import { PrismaClient } from '@prisma/client'
import { createNote } from './db/notes.ts'
import { warmup } from './db/embeddings.ts'

const prisma = new PrismaClient()

// ─── YAML frontmatter parser ──────────────────────────────────────────────────

function parseFrontmatter(content: string): {
  data: Record<string, unknown>
  body: string
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { data: {}, body: content }
  try {
    const data = (parseYaml(match[1]!) ?? {}) as Record<string, unknown>
    return { data, body: match[2]!.trimStart() }
  } catch {
    return { data: {}, body: content }
  }
}

// ─── Git helper — autor del ultimo commit ─────────────────────────────────────

async function gitAuthor(filePath: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', 'log', '-1', '--pretty=%an', '--', filePath], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const name = out.trim()
    return name || null
  } catch {
    return null
  }
}

// ─── Tag de idempotencia ──────────────────────────────────────────────────────

function originTag(repoName: string, relPath: string): string {
  // Normaliza separadores a /
  const norm = relPath.replace(/\\/g, '/')
  return `origen:${repoName}:${norm}`
}

async function alreadyImported(prisma: PrismaClient, tag: string): Promise<boolean> {
  const count = await prisma.note.count({
    where: {
      deleted_at: null,
      tags: { array_contains: [tag] },
    },
  })
  return count > 0
}

// ─── Tipos de resultado ───────────────────────────────────────────────────────

type ImportStats = {
  source: string
  created: number
  skipped: number
  errors: number
  errorDetails: string[]
}

// ─── Inferencia de app y kind ─────────────────────────────────────────────────

function inferAppFromSystemasPath(relPath: string): string {
  // sistemas/cartera/... -> cartera
  // sistemas/api-scoring/... -> api-scoring
  // sistemas/xxx/... -> xxx
  const parts = relPath.replace(/\\/g, '/').split('/')
  if (parts[0] === 'sistemas' && parts.length >= 2) {
    return parts[1]!
  }
  return 'general'
}

function inferKindFromFrontmatter(data: Record<string, unknown>, isSistemas: boolean): string {
  if (isSistemas) return 'sistema'
  // Para learnings: kind del frontmatter o 'pitfall' por defecto
  const rawKind = data.kind ?? data.tipo
  if (typeof rawKind === 'string') {
    const k = rawKind.toLowerCase().trim()
    if (k === 'decision' || k === 'decisión') return 'decision'
    if (k === 'pitfall' || k === 'pit-fall') return 'pitfall'
    if (k === 'regla') return 'regla'
    if (k === 'flujo') return 'flujo'
    if (k === 'sistema') return 'sistema'
  }
  // Heurística: si tiene always_follow o es "regla" -> regla
  if (data.always_follow !== undefined) return 'regla'
  return 'pitfall'
}

// ─── Importación de un archivo .md ────────────────────────────────────────────

async function importFile(opts: {
  filePath: string
  repoName: string
  relPath: string
  app: string
  kind: string
  stats: ImportStats
}): Promise<void> {
  const { filePath, repoName, relPath, app, kind, stats } = opts

  const tag = originTag(repoName, relPath)

  // Idempotencia: si ya existe una nota con este tag, saltear
  if (await alreadyImported(prisma, tag)) {
    stats.skipped++
    return
  }

  let rawContent: string
  try {
    rawContent = await readFile(filePath, 'utf-8')
  } catch (err) {
    stats.errors++
    stats.errorDetails.push(`${relPath}: no se pudo leer — ${err}`)
    return
  }

  const { data, body } = parseFrontmatter(rawContent)

  // Excluir superseded
  const status = data.status ?? data.estado
  if (typeof status === 'string' && status.toLowerCase() === 'superseded') {
    stats.skipped++
    return
  }

  // Título: frontmatter.title o primera linea H1
  let title = typeof data.title === 'string' ? data.title : ''
  if (!title) {
    const h1 = body.match(/^#\s+(.+)$/m)
    title = h1 ? h1[1]!.trim() : basename(filePath, '.md')
  }

  // Body: usar el cuerpo sin frontmatter; si esta vacio usar todo el raw
  const bodyMd = body.trim() || rawContent.trim()
  if (!bodyMd) {
    stats.skipped++
    return
  }

  // Author: frontmatter.author | frontmatter.de | git log | 'importador'
  let author =
    typeof data.author === 'string'
      ? data.author
      : typeof data.de === 'string'
        ? data.de
        : null
  if (!author) {
    author = (await gitAuthor(filePath)) ?? 'importador'
  }

  // Issue: frontmatter.issue | frontmatter.ticket
  const issue =
    typeof data.issue === 'string' ? data.issue : typeof data.ticket === 'string' ? data.ticket : undefined

  // Tags: siempre incluye el tag de origen para idempotencia
  const tags = [tag]

  try {
    const result = await createNote(prisma, {
      title,
      body_md: bodyMd,
      app,
      kind,
      tags,
      author,
      issue,
      force: true, // Importacion: siempre crear aunque haya similares (distintos repositorios pueden tener overlap)
    })

    if (result.status === 'created') {
      stats.created++
      console.log(`  [+] ${relPath}`)
    } else {
      // similar_exists con force:true no deberia pasar, pero por si acaso
      stats.skipped++
      console.log(`  [~] ${relPath} (similar ya existe)`)
    }
  } catch (err) {
    stats.errors++
    const msg = err instanceof Error ? err.message : String(err)
    stats.errorDetails.push(`${relPath}: error al crear nota — ${msg}`)
    console.error(`  [!] ${relPath}: ${msg}`)
  }
}

// ─── Recorrido de archivos ────────────────────────────────────────────────────

async function* walkMd(dir: string): AsyncGenerator<string> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue // skip .git, .bitacora cache, etc.
    const full = join(dir, name)
    let s
    try { s = await stat(full) } catch { continue }
    if (s.isDirectory()) {
      yield* walkMd(full)
    } else if (s.isFile() && name.endsWith('.md')) {
      yield full
    }
  }
}

// ─── Forma (a): repo novara-knowledge ──────────────────────────────────────

async function importKnowledgeRepo(rootPath: string): Promise<ImportStats> {
  const absRoot = resolve(rootPath)
  const repoName = basename(absRoot)
  const stats: ImportStats = { source: `novara-knowledge (${absRoot})`, created: 0, skipped: 0, errors: 0, errorDetails: [] }

  console.log(`\n[Fuente A] novara-knowledge: ${absRoot}`)

  // sistemas/**/*.md
  const sistemasDir = join(absRoot, 'sistemas')
  for await (const filePath of walkMd(sistemasDir)) {
    const relPath = relative(absRoot, filePath).replace(/\\/g, '/')
    const app = inferAppFromSystemasPath(relPath)
    await importFile({ filePath, repoName, relPath, app, kind: 'sistema', stats })
  }

  // .bitacora/learnings/*.md (solo el directorio inmediato)
  const learningsDir = join(absRoot, '.bitacora', 'learnings')
  try {
    const entries = await readdir(learningsDir)
    for (const name of entries) {
      if (!name.endsWith('.md')) continue
      const filePath = join(learningsDir, name)
      const s = await stat(filePath).catch(() => null)
      if (!s?.isFile()) continue
      const relPath = relative(absRoot, filePath).replace(/\\/g, '/')
      const rawContent = await readFile(filePath, 'utf-8').catch(() => '')
      const { data } = parseFrontmatter(rawContent)
      const kind = inferKindFromFrontmatter(data, false)
      await importFile({ filePath, repoName, relPath, app: 'general', kind, stats })
    }
  } catch {
    // learnings dir no existe — OK
  }

  return stats
}

// ─── Forma (b): repo de codigo con .bitacora/learnings/ ─────────────────────────

async function importCodeRepo(rootPath: string): Promise<ImportStats> {
  const absRoot = resolve(rootPath)
  const repoName = basename(absRoot)
  const stats: ImportStats = { source: `code-repo:${repoName} (${absRoot})`, created: 0, skipped: 0, errors: 0, errorDetails: [] }

  console.log(`\n[Fuente B] repo de codigo: ${absRoot}`)

  const learningsDir = join(absRoot, '.bitacora', 'learnings')
  try {
    const s = await stat(learningsDir)
    if (!s.isDirectory()) throw new Error('not a directory')
  } catch {
    console.log(`  (sin .bitacora/learnings/ en ${repoName} — saltando)`)
    return stats
  }

  const entries = await readdir(learningsDir)
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    const filePath = join(learningsDir, name)
    const fs = await stat(filePath).catch(() => null)
    if (!fs?.isFile()) continue
    const relPath = relative(absRoot, filePath).replace(/\\/g, '/')
    const rawContent = await readFile(filePath, 'utf-8').catch(() => '')
    const { data } = parseFrontmatter(rawContent)
    const kind = inferKindFromFrontmatter(data, false)
    await importFile({ filePath, repoName, relPath, app: repoName, kind, stats })
  }

  return stats
}

// ─── Deteccion de tipo de repo ────────────────────────────────────────────────

async function detectAndImport(rootPath: string): Promise<ImportStats> {
  const absRoot = resolve(rootPath)

  // Si tiene /sistemas/ -> forma (a)
  try {
    const s = await stat(join(absRoot, 'sistemas'))
    if (s.isDirectory()) {
      return importKnowledgeRepo(rootPath)
    }
  } catch { /* no sistemas dir */ }

  // Sino -> forma (b) repo de codigo
  return importCodeRepo(rootPath)
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const [, , ...args] = process.argv

if (!args.length || args[0] === '--help') {
  console.log(`
Uso: bun run import -- <ruta>

Importa notas desde:
  (a) Un clon de novara-knowledge (tiene /sistemas/)
  (b) Un repo de codigo con .bitacora/learnings/

Opciones:
  --help    Muestra esta ayuda

Ejemplos:
  bun run import -- /srv/repos/novara-knowledge
  bun run import -- /srv/repos/nucleo-core/backend
  bun run import -- /srv/repos/nucleo-core/frontend
`)
  process.exit(0)
}

console.log('[importador] Calentando modelo ONNX (warmup)...')
await warmup()
console.log('[importador] Modelo listo. Iniciando importacion...')

const allStats: ImportStats[] = []
for (const path of args) {
  const stats = await detectAndImport(path)
  allStats.push(stats)
}

await prisma.$disconnect()

// Reporte final
console.log('\n════════════════════════════════════════════')
console.log('REPORTE DE IMPORTACION')
console.log('════════════════════════════════════════════')
let totalCreated = 0
let totalSkipped = 0
let totalErrors = 0
for (const s of allStats) {
  console.log(`\n${s.source}`)
  console.log(`  Creadas:  ${s.created}`)
  console.log(`  Saltadas: ${s.skipped}`)
  console.log(`  Errores:  ${s.errors}`)
  if (s.errorDetails.length) {
    for (const d of s.errorDetails) console.error(`    ! ${d}`)
  }
  totalCreated += s.created
  totalSkipped += s.skipped
  totalErrors += s.errors
}
console.log('\n────────────────────────────────────────────')
console.log(`TOTAL  Creadas: ${totalCreated}  Saltadas: ${totalSkipped}  Errores: ${totalErrors}`)
console.log('════════════════════════════════════════════')

if (totalErrors > 0) process.exit(1)
