import { type PrismaClient, Prisma } from '@prisma/client'
import {
  NOTE_KINDS,
  type NoteKind,
  duplicateThreshold,
  DUPLICATE_DISTINCT_MARGIN,
  TITLE_SIMILARITY_THRESHOLD,
  ISSUE_NORMALIZED_SQL,
} from './constants.ts'
import { generateUlid } from './ulid.ts'
import { embed } from './embeddings.ts'
import { resolveApp, appFilterValues } from './apps.ts'
import { isJournalNote, isStrictNotesMode, journalField } from './note-quality.ts'

// ─── Tipos públicos ────────────────────────────────────────────────────────────

export type NoteDto = {
  id: string
  title: string
  body_md: string
  app: string
  kind: NoteKind
  tags: string[]
  author: string
  issue: string | null
  rev: number
  force_reason: string | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

export type NoteRevisionDto = {
  note_id: string
  rev: number
  title: string
  body_md: string
  tags: string[]
  author: string
  reason: string | null
  created_at: Date
}

export type DuplicateCandidate = {
  id: string
  title: string
  score: number
  app: string
  kind: NoteKind
  issue: string | null
  updated_at: Date
  same_issue: boolean
  same_kind: boolean
  matched_by: 'coseno' | 'issue_y_titulo'
}

export type LexicalResult = {
  id: string
  title: string
  snippet: string
  score: number
}

export type WriteResult =
  | { status: 'created'; note: NoteDto; warnings: string[] }
  | { status: 'similar_exists'; candidates: DuplicateCandidate[] }

// ─── Errores ──────────────────────────────────────────────────────────────────

export class ValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends Error {
  constructor(
    message: string,
    public readonly current_rev: number,
  ) {
    super(message)
    this.name = 'ConflictError'
  }
}

// ─── Input types ──────────────────────────────────────────────────────────────

export type CreateInput = {
  title: string
  body_md: string
  app: string
  kind: string
  tags?: string[]
  author: string
  issue?: string | null
  force?: boolean
  reason?: string
}

export type UpdateInput = {
  title?: string
  body_md?: string
  tags?: string[]
  app?: string
  kind?: NoteKind
  author: string
  reason?: string
  base_rev?: number
  issue?: string | null
}

export type ListFilter = {
  app?: string
  /** Incluir la app transversal `general` al filtrar por `app` (default true). */
  include_general?: boolean
  kind?: string
  tags?: string[]
  author?: string
  issue?: string
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

type NoteRow = {
  id: string
  title: string
  body_md: string
  app: string
  kind: string
  tags: Prisma.JsonValue
  author: string
  issue: string | null
  rev: number
  force_reason: string | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

function toNoteDto(note: NoteRow): NoteDto {
  return {
    id: note.id,
    title: note.title,
    body_md: note.body_md,
    app: note.app,
    kind: note.kind as NoteKind,
    tags: (note.tags as string[] | null) ?? [],
    author: note.author,
    issue: note.issue,
    rev: note.rev,
    force_reason: note.force_reason,
    created_at: note.created_at,
    updated_at: note.updated_at,
    deleted_at: note.deleted_at,
  }
}

function toNoteRevisionDto(r: {
  note_id: string
  rev: number
  title: string
  body_md: string
  tags: Prisma.JsonValue | unknown
  author: string
  reason: string | null
  created_at: Date
}): NoteRevisionDto {
  return {
    note_id: r.note_id,
    rev: r.rev,
    title: r.title,
    body_md: r.body_md,
    tags: (r.tags as string[] | null) ?? [],
    author: r.author,
    reason: r.reason,
    created_at: r.created_at,
  }
}

function snippet(body: string, maxLen = 200): string {
  return body.length <= maxLen ? body : body.substring(0, maxLen) + '…'
}

function validateCreate(input: CreateInput): void {
  if (!input.author || input.author.trim() === '') {
    throw new ValidationError('El campo author es requerido', 'author')
  }
  if (!input.app || input.app.trim() === '') {
    throw new ValidationError('El campo app es requerido', 'app')
  }
  if (!NOTE_KINDS.includes(input.kind as NoteKind)) {
    throw new ValidationError(
      `kind inválido: "${input.kind}". Valores válidos: ${NOTE_KINDS.join(', ')}`,
      'kind',
    )
  }
  if (!input.title || input.title.trim() === '') {
    throw new ValidationError('El campo title es requerido', 'title')
  }
  if (!input.body_md || input.body_md.trim() === '') {
    throw new ValidationError('El campo body_md es requerido', 'body_md')
  }
  if (input.force && !input.reason?.trim()) {
    throw new ValidationError('El campo reason es requerido cuando force es true', 'reason')
  }
  // Modo estricto opt-in: por defecto la bitácora entra con una advertencia (tool),
  // con CORTEX_STRICT_NOTES la capa de datos la rechaza.
  if (isStrictNotesMode() && isJournalNote(input.title, input.body_md)) {
    throw new ValidationError(
      'el contenido parece una bitácora (registro de actividad), no conocimiento reutilizable. ' +
        'Guardá la decisión, la regla o el pitfall que deja el trabajo; ' +
        'o quitá CORTEX_STRICT_NOTES para permitir bitácoras con advertencia.',
      journalField(input.title, input.body_md),
    )
  }
}

/** Entrada para clasificar un candidato duplicado (desde la BD + título similarity). */
type CandidateInput = {
  score: number
  title_sim: number
  kind: string
  issue: string | null
}

/** Metadatos de la nota nueva que se está intentando crear. */
type NewNoteInput = {
  kind: string
  issue?: string
}

/**
 * Clasifica un candidato según las reglas de deduplicación (design D3).
 * Puro: sin I/O, fácil de testear con números explícitos.
 * Orden fijo: coseno (con margen) → issue_y_titulo.
 */
export function classifyCandidate(
  c: CandidateInput,
  input: NewNoteInput,
  T: number,
): { matched_by: 'coseno' | 'issue_y_titulo'; same_issue: boolean; same_kind: boolean } | null {
  const normalizeIssue = (v: string | null | undefined): string | null => {
    if (!v) return null
    const t = v.trim().toLowerCase()
    return t === '' ? null : t
  }

  const cIssue = normalizeIssue(c.issue)
  const nIssue = normalizeIssue(input.issue)
  const same_issue = cIssue !== null && nIssue !== null && cIssue === nIssue
  const same_kind = c.kind === input.kind
  const distinct = !same_kind || (cIssue !== null && nIssue !== null && cIssue !== nIssue)
  const required = T + (distinct ? DUPLICATE_DISTINCT_MARGIN : 0)

  if (c.score >= required) {
    return { matched_by: 'coseno', same_issue, same_kind }
  }
  if (same_issue && c.title_sim >= TITLE_SIMILARITY_THRESHOLD) {
    return { matched_by: 'issue_y_titulo', same_issue, same_kind }
  }
  return null
}

async function findDuplicates(
  prisma: PrismaClient,
  vector: number[],
  input: { kind: string; issue?: string; title: string },
  T: number,
): Promise<DuplicateCandidate[]> {
  const vecStr = `[${vector.join(',')}]`
  const nIssue = input.issue?.trim().toLowerCase() ?? ''
  const hasIssue = nIssue !== ''

  const rows = await prisma.$queryRaw<{
    id: string
    title: string
    score: number
    app: string
    kind: string
    issue: string | null
    updated_at: Date
    title_sim: number
  }[]>(
    hasIssue
      ? Prisma.sql`
        SELECT id, title,
               1 - (embedding <=> ${vecStr}::vector(768)) AS score,
               app, kind, issue, updated_at,
               similarity(unaccent(title), unaccent(${input.title})) AS title_sim
        FROM notes
        WHERE deleted_at IS NULL
          AND embedding IS NOT NULL
          AND (
            1 - (embedding <=> ${vecStr}::vector(768)) >= ${T}
            OR lower(btrim(coalesce(issue, ''))) = ${nIssue}
          )
        ORDER BY embedding <=> ${vecStr}::vector(768)
        LIMIT 50
      `
      : Prisma.sql`
        SELECT id, title,
               1 - (embedding <=> ${vecStr}::vector(768)) AS score,
               app, kind, issue, updated_at,
               similarity(unaccent(title), unaccent(${input.title})) AS title_sim
        FROM notes
        WHERE deleted_at IS NULL
          AND embedding IS NOT NULL
          AND 1 - (embedding <=> ${vecStr}::vector(768)) >= ${T}
        ORDER BY embedding <=> ${vecStr}::vector(768)
        LIMIT 50
      `,
  )

  const classified: DuplicateCandidate[] = []
  for (const r of rows) {
    const result = classifyCandidate(
      { score: Number(r.score), title_sim: Number(r.title_sim), kind: r.kind, issue: r.issue },
      { kind: input.kind, issue: input.issue },
      T,
    )
    if (result) {
      classified.push({
        id: r.id,
        title: r.title,
        score: Number(r.score),
        app: r.app,
        kind: r.kind as NoteKind,
        issue: r.issue,
        updated_at: r.updated_at,
        same_issue: result.same_issue,
        same_kind: result.same_kind,
        matched_by: result.matched_by,
      })
    }
  }

  // Orden: score desc; corte a 5
  classified.sort((a, b) => b.score - a.score)
  return classified.slice(0, 5)
}

// ─── API pública ──────────────────────────────────────────────────────────────

export async function createNote(
  prisma: PrismaClient,
  input: CreateInput,
): Promise<WriteResult> {
  validateCreate(input)

  // `app` es texto libre: se normaliza, se resuelve alias y se valida el vocabulario
  // (si hay `CORTEX_APPS`). El valor persistido es siempre el canónico.
  const resolvedApp = resolveApp(input.app)
  if (!resolvedApp.ok) throw new ValidationError(resolvedApp.message, 'app')

  const id = generateUlid()
  const tags = input.tags ?? []
  const vector = await embed(input.title + ' ' + input.body_md)
  const issue = input.issue?.trim() ? input.issue : null

  if (!input.force) {
    const T = duplicateThreshold()
    const candidates = await findDuplicates(
      prisma,
      vector,
      { kind: input.kind, issue: issue ?? undefined, title: input.title },
      T,
    )
    if (candidates.length > 0) {
      return { status: 'similar_exists', candidates }
    }
  }

  const vecStr = `[${vector.join(',')}]`

  await prisma.$transaction(async (tx) => {
    await tx.note.create({
      data: {
        id,
        title: input.title,
        body_md: input.body_md,
        app: resolvedApp.app,
        kind: input.kind,
        tags,
        author: input.author,
        issue: issue,
        force_reason: input.force ? (input.reason!.trim()) : null,
      },
    })
    // embedding es Unsupported en Prisma → $executeRaw
    await tx.$executeRaw(
      Prisma.sql`UPDATE notes SET embedding = ${vecStr}::vector(768) WHERE id = ${id}`,
    )
  })

  const created = await prisma.note.findUniqueOrThrow({ where: { id } })
  return {
    status: 'created',
    note: toNoteDto(created as unknown as NoteRow),
    warnings: resolvedApp.warnings,
  }
}

export async function readNote(
  prisma: PrismaClient,
  id: string,
): Promise<NoteDto & { is_deleted?: true }> {
  const note = await prisma.note.findUnique({ where: { id } })
  if (!note) throw new NotFoundError(`Nota ${id} no encontrada`)
  const dto = toNoteDto(note as unknown as NoteRow)
  if (note.deleted_at) return { ...dto, is_deleted: true }
  return dto
}

export async function updateNote(
  prisma: PrismaClient,
  id: string,
  input: UpdateInput,
): Promise<NoteDto & { warnings?: string[] }> {
  if (!input.author || input.author.trim() === '') {
    throw new ValidationError('El campo author es requerido para actualizar', 'author')
  }
  // `kind` llega validado por el schema de la tool, pero la capa de datos no confía
  // en sus llamadores: la clasificación se valida acá, igual que en createNote.
  if (input.kind !== undefined && !NOTE_KINDS.includes(input.kind)) {
    throw new ValidationError(
      `kind inválido: "${input.kind}". Valores válidos: ${NOTE_KINDS.join(', ')}`,
      'kind',
    )
  }
  if (input.app !== undefined && input.app.trim() === '') {
    throw new ValidationError('El campo app no puede estar vacío', 'app')
  }
  // `app` de la corrección de clasificación: mismo camino que createNote (alias +
  // vocabulario). El valor escrito es el canónico, no el que llegó.
  let resolvedApp: { app: string; warnings: string[] } | undefined
  if (input.app !== undefined) {
    const resolved = resolveApp(input.app)
    if (!resolved.ok) throw new ValidationError(resolved.message, 'app')
    resolvedApp = { app: resolved.app, warnings: resolved.warnings }
  }
  if (input.issue !== undefined && input.issue !== null && input.issue.trim() === '') {
    throw new ValidationError('El campo issue no puede estar vacío — usa null para quitarlo', 'issue')
  }

  // ── NB-4 fix: embed() FUERA de la transacción interactiva ──────────────────
  // El reviewer midió embed() en 1.84s con modelo caliente — demasiado cerca del
  // límite de 5s de Prisma $transaction. En frío (primera llamada) lo revienta con P2028.
  // Estrategia: pre-leer sin bloqueo para saber el contenido actual, calcular el
  // embedding fuera de la tx, y luego escribirlo dentro (tx rápida, solo SQL).
  // Trade-off TOCTOU aceptado (Decisión 3c): si otra escritura ocurre entre pre-read
  // y la tx, base_rev lo detecta; sin base_rev, last-writer-wins (embedding puede ser
  // 1 actualización desincronizado, se autocorrige en el siguiente cortex_update).
  let newVector: number[] | null = null
  if (input.title !== undefined || input.body_md !== undefined) {
    const preRead = await prisma.note.findUnique({ where: { id } })
    if (!preRead || preRead.deleted_at) {
      throw new NotFoundError(`Nota ${id} no encontrada`)
    }
    const computeTitle = input.title ?? preRead.title
    const computeBody = input.body_md ?? preRead.body_md
    newVector = await embed(computeTitle + ' ' + computeBody)
  }

  return prisma.$transaction(async (tx) => {
    // Bloqueo pesimista sobre la fila
    const rows = await tx.$queryRaw<NoteRow[]>(
      Prisma.sql`SELECT id, title, body_md, app, kind, tags, author, issue, rev, force_reason,
                        created_at, updated_at, deleted_at
                 FROM notes WHERE id = ${id} FOR UPDATE`,
    )
    const current = rows[0]
    if (!current) throw new NotFoundError(`Nota ${id} no encontrada`)
    if (current.deleted_at) throw new NotFoundError(`Nota ${id} está borrada`)

    if (input.base_rev !== undefined && input.base_rev !== current.rev) {
      throw new ConflictError(
        `La revisión actual es ${current.rev}, no ${input.base_rev}`,
        current.rev,
      )
    }

    // Inserta versión anterior en note_revisions (misma transacción)
    await tx.noteRevision.create({
      data: {
        note_id: current.id,
        rev: current.rev,
        title: current.title,
        body_md: current.body_md,
        tags: (current.tags as string[]) ?? [],
        author: current.author,
        reason: input.reason ?? null,
      },
    })

    const newTitle = input.title ?? current.title
    const newBodyMd = input.body_md ?? current.body_md
    const newTags = input.tags !== undefined ? input.tags : ((current.tags as string[]) ?? [])

    // Actualiza la nota (Prisma @updatedAt maneja updated_at).
    // `app`/`kind` solo se escriben cuando vienen definidos. La clasificación es metadata
    // corregible: `note_revisions` no guarda app/kind, así que la corrección no deja
    // rastro del valor anterior (design D3 — el contenido y su autoría sí quedan).
    await tx.note.update({
      where: { id },
      data: {
        title: newTitle,
        body_md: newBodyMd,
        tags: newTags,
        ...(resolvedApp !== undefined ? { app: resolvedApp.app } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.issue !== undefined ? { issue: input.issue === null ? null : input.issue.trim() } : {}),
        author: input.author,
        rev: { increment: 1 },
      },
    })

    // Escribe el embedding precalculado fuera de la tx (ya calculado antes de entrar)
    if (newVector) {
      const vecStr = `[${newVector.join(',')}]`
      await tx.$executeRaw(
        Prisma.sql`UPDATE notes SET embedding = ${vecStr}::vector(768) WHERE id = ${id}`,
      )
    }

    const updated = await tx.note.findUniqueOrThrow({ where: { id } })
    const dto = toNoteDto(updated as unknown as NoteRow)
    return resolvedApp && resolvedApp.warnings.length > 0
      ? { ...dto, warnings: resolvedApp.warnings }
      : dto
  })
}

// ─── Filtro compartido de listado ─────────────────────────────────────────────

/**
 * Construye el `where` de Prisma para listados de notas.
 * El filtro de `issue` se resuelve con una consulta SQL previa (índice notes_issue_idx).
 * El filtro de `tags` pasa a SQL (`array_contains`) para que `take/skip` funcione bien (D5).
 */
async function buildListFilter(
  prisma: PrismaClient,
  filter: ListFilter,
): Promise<Prisma.NoteWhereInput> {
  let issueIds: string[] | null = null
  const issueTrimmed = filter.issue?.trim()
  if (issueTrimmed) {
    const rows = await prisma.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM notes WHERE deleted_at IS NULL AND ${ISSUE_NORMALIZED_SQL} = lower(${issueTrimmed})`,
    )
    issueIds = rows.map((r) => r.id)
  }

  return {
    deleted_at: null,
    ...(filter.app ? { app: { in: appFilterValues(filter.app, filter.include_general !== false) } } : {}),
    ...(filter.kind ? { kind: filter.kind } : {}),
    ...(filter.author ? { author: filter.author } : {}),
    ...(issueIds !== null ? { id: { in: issueIds } } : {}),
    ...(filter.tags?.length ? { tags: { array_contains: filter.tags } } : {}),
  }
}

export async function listNotes(
  prisma: PrismaClient,
  filter: ListFilter = {},
): Promise<NoteDto[]> {
  const where = await buildListFilter(prisma, filter)
  const notes = await prisma.note.findMany({
    where,
    orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
  })
  return notes.map((n) => toNoteDto(n as unknown as NoteRow))
}

/**
 * Listado paginado de notas. `total` = count con el mismo `where`.
 * Usa `Promise.all` (no `$transaction`): `src/db/retry.ts:115` clasifica
 * `$transaction` como escritura y no reintenta lecturas (D4).
 */
export async function listNotesPage(
  prisma: PrismaClient,
  filter: ListFilter,
  { limit, offset }: { limit: number; offset: number },
): Promise<{ total: number; items: NoteDto[] }> {
  const where = await buildListFilter(prisma, filter)
  const [total, notes] = await Promise.all([
    prisma.note.count({ where }),
    prisma.note.findMany({
      where,
      orderBy: [{ updated_at: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: offset,
    }),
  ])
  return { total, items: notes.map((n) => toNoteDto(n as unknown as NoteRow)) }
}

/**
 * Apps vigentes con su cantidad de notas (no borradas), ordenadas por nombre.
 * Es el descubrimiento del vocabulario real: qué valores existen hoy, más allá de la
 * lista canónica configurada.
 */
export async function countNotesByApp(
  prisma: PrismaClient,
): Promise<{ app: string; count: number }[]> {
  const rows = await prisma.note.groupBy({
    by: ['app'],
    where: { deleted_at: null },
    _count: { _all: true },
    orderBy: { app: 'asc' },
  })
  return rows.map((r) => ({ app: r.app, count: r._count._all }))
}

export async function softDeleteNote(
  prisma: PrismaClient,
  id: string,
  author: string,
  reason: string,
): Promise<{ id: string; deleted_at: Date; rev: number }> {
  if (!author || author.trim() === '') {
    throw new ValidationError('El campo author es requerido para borrar', 'author')
  }
  if (!reason || reason.trim() === '') {
    throw new ValidationError('El campo reason es requerido para borrar', 'reason')
  }

  return prisma.$transaction(async (tx) => {
    // Bloqueo pesimista sobre la fila; sin embed() — la transacción debe ser rápida
    const rows = await tx.$queryRaw<NoteRow[]>(
      Prisma.sql`SELECT id, title, body_md, app, kind, tags, author, issue, rev, force_reason,
                        created_at, updated_at, deleted_at
               FROM notes WHERE id = ${id} FOR UPDATE`,
    )
    const note = rows[0]
    if (!note) throw new NotFoundError(`Nota ${id} no encontrada`)
    if (note.deleted_at) throw new NotFoundError(`Nota ${id} ya está borrada`)

    // Inserta revisión final con el estado vigente. La autoría es la del contenido
    // (no la de quien borra); quién borró y por qué queda en el `reason`.
    await tx.noteRevision.create({
      data: {
        note_id: note.id,
        rev: note.rev,
        title: note.title,
        body_md: note.body_md,
        tags: (note.tags as string[]) ?? [],
        author: note.author,
        reason: `${reason} (borrada por ${author})`,
      },
    })

    // La revisión final ya ocupa `note.rev`; avanzar la nota libera ese número
    // para la próxima actualización (PK de note_revisions es (note_id, rev)).
    const updated = await tx.note.update({
      where: { id },
      data: { deleted_at: new Date(), rev: { increment: 1 } },
    })

    return { id, deleted_at: updated.deleted_at as Date, rev: updated.rev }
  })
}

export async function getNoteHistory(
  prisma: PrismaClient,
  noteId: string,
): Promise<NoteRevisionDto[]> {
  const revisions = await prisma.noteRevision.findMany({
    where: { note_id: noteId },
    orderBy: { rev: 'asc' },
  })
  return revisions.map(toNoteRevisionDto)
}

/**
 * Historial paginado de una nota.
 *
 * - Sin `rev`: las `limit` revisiones más recientes (rev desc, luego invertidas a asc).
 *   `total` = count total de revisiones.
 * - Con `rev`: revisión puntual; lanza `NotFoundError` si no existe (pista: cortex_read
 *   para la versión vigente).
 */
export async function getNoteHistoryPage(
  prisma: PrismaClient,
  noteId: string,
  { limit, rev }: { limit?: number; rev?: number },
): Promise<{ total: number; items: NoteRevisionDto[] }> {
  if (rev !== undefined) {
    const [revision, total] = await Promise.all([
      prisma.noteRevision.findUnique({
        where: { note_id_rev: { note_id: noteId, rev } },
      }),
      prisma.noteRevision.count({ where: { note_id: noteId } }),
    ])
    if (!revision) {
      throw new NotFoundError(
        `Revisión ${rev} de la nota ${noteId} no existe en el historial (la versión vigente se lee con cortex_read)`,
      )
    }
    return { total, items: [toNoteRevisionDto(revision)] }
  }

  const lim = limit ?? 10
  const [total, revisions] = await Promise.all([
    prisma.noteRevision.count({ where: { note_id: noteId } }),
    prisma.noteRevision.findMany({
      where: { note_id: noteId },
      orderBy: { rev: 'desc' },
      take: lim,
    }),
  ])
  // Invertir a ascendente (más recientes primero en findMany; queremos rev asc en la respuesta)
  const items = [...revisions].reverse().map(toNoteRevisionDto)
  return { total, items }
}

/** Búsqueda léxica (task 1.4) — full-text Postgres español, insensible a tildes. */
export async function lexicalSearch(
  prisma: PrismaClient,
  query: string,
  filter: { app?: string; include_general?: boolean; kind?: string } = {},
): Promise<LexicalResult[]> {
  const appCond = filter.app
    ? Prisma.sql`AND app IN (${Prisma.join(appFilterValues(filter.app, filter.include_general !== false))})`
    : Prisma.empty
  const kindCond = filter.kind ? Prisma.sql`AND kind = ${filter.kind}` : Prisma.empty

  const rows = await prisma.$queryRaw<{ id: string; title: string; body_md: string; score: number }[]>(
    Prisma.sql`
      SELECT id, title, body_md,
             ts_rank(fts, websearch_to_tsquery('spanish', unaccent(${query}))) AS score
      FROM notes
      WHERE deleted_at IS NULL
        AND fts @@ websearch_to_tsquery('spanish', unaccent(${query}))
        ${appCond}
        ${kindCond}
      ORDER BY score DESC
      LIMIT 20
    `,
  )

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    snippet: snippet(r.body_md),
    score: Number(r.score),
  }))
}
