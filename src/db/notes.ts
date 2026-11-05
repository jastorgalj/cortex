import { type PrismaClient, Prisma } from '@prisma/client'
import { NOTE_KINDS, type NoteKind, DUPLICATE_THRESHOLD } from './constants.ts'
import { generateUlid } from './ulid.ts'
import { embed } from './embeddings.ts'

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
}

export type LexicalResult = {
  id: string
  title: string
  snippet: string
  score: number
}

export type WriteResult =
  | { status: 'created'; note: NoteDto }
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
  issue?: string
  force?: boolean
}

export type UpdateInput = {
  title?: string
  body_md?: string
  tags?: string[]
  author: string
  reason?: string
  base_rev?: number
}

export type ListFilter = {
  app?: string
  kind?: string
  tags?: string[]
  author?: string
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
    created_at: note.created_at,
    updated_at: note.updated_at,
    deleted_at: note.deleted_at,
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
}

async function findDuplicates(
  prisma: PrismaClient,
  vector: number[],
): Promise<DuplicateCandidate[]> {
  const vecStr = `[${vector.join(',')}]`
  const rows = await prisma.$queryRaw<{ id: string; title: string; score: number }[]>(
    Prisma.sql`
      SELECT id, title,
             1 - (embedding <=> ${vecStr}::vector(768)) AS score
      FROM notes
      WHERE deleted_at IS NULL
        AND embedding IS NOT NULL
        AND 1 - (embedding <=> ${vecStr}::vector(768)) >= ${DUPLICATE_THRESHOLD}
      ORDER BY embedding <=> ${vecStr}::vector(768)
      LIMIT 5
    `,
  )
  return rows.map((r) => ({ id: r.id, title: r.title, score: Number(r.score) }))
}

// ─── API pública ──────────────────────────────────────────────────────────────

export async function createNote(
  prisma: PrismaClient,
  input: CreateInput,
): Promise<WriteResult> {
  validateCreate(input)

  const id = generateUlid()
  const tags = input.tags ?? []
  const vector = await embed(input.title + ' ' + input.body_md)

  if (!input.force) {
    const candidates = await findDuplicates(prisma, vector)
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
        app: input.app,
        kind: input.kind,
        tags,
        author: input.author,
        issue: input.issue ?? null,
      },
    })
    // embedding es Unsupported en Prisma → $executeRaw
    await tx.$executeRaw(
      Prisma.sql`UPDATE notes SET embedding = ${vecStr}::vector(768) WHERE id = ${id}`,
    )
  })

  const created = await prisma.note.findUniqueOrThrow({ where: { id } })
  return { status: 'created', note: toNoteDto(created as unknown as NoteRow) }
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
): Promise<NoteDto> {
  if (!input.author || input.author.trim() === '') {
    throw new ValidationError('El campo author es requerido para actualizar', 'author')
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
      Prisma.sql`SELECT id, title, body_md, app, kind, tags, author, issue, rev,
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

    // Actualiza la nota (Prisma @updatedAt maneja updated_at)
    await tx.note.update({
      where: { id },
      data: {
        title: newTitle,
        body_md: newBodyMd,
        tags: newTags,
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
    return toNoteDto(updated as unknown as NoteRow)
  })
}

export async function listNotes(
  prisma: PrismaClient,
  filter: ListFilter = {},
): Promise<NoteDto[]> {
  const notes = await prisma.note.findMany({
    where: {
      deleted_at: null,
      ...(filter.app ? { app: filter.app } : {}),
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.author ? { author: filter.author } : {}),
    },
    orderBy: { updated_at: 'desc' },
  })

  let result = notes.map((n) => toNoteDto(n as unknown as NoteRow))

  // Filtro de tags en memoria (corpus pequeño — megabytes)
  if (filter.tags?.length) {
    result = result.filter((n) => filter.tags!.every((tag) => n.tags.includes(tag)))
  }

  return result
}

export async function softDeleteNote(
  prisma: PrismaClient,
  id: string,
  author: string,
  reason: string,
): Promise<{ id: string; deleted_at: Date }> {
  return prisma.$transaction(async (tx) => {
    // Bloqueo pesimista sobre la fila; sin embed() — la transacción debe ser rápida
    const rows = await tx.$queryRaw<NoteRow[]>(
      Prisma.sql`SELECT id, title, body_md, app, kind, tags, author, issue, rev,
                        created_at, updated_at, deleted_at
               FROM notes WHERE id = ${id} FOR UPDATE`,
    )
    const note = rows[0]
    if (!note) throw new NotFoundError(`Nota ${id} no encontrada`)
    if (note.deleted_at) throw new NotFoundError(`Nota ${id} ya está borrada`)

    // Inserta revisión final con el estado vigente, el autor y el motivo del borrado
    await tx.noteRevision.create({
      data: {
        note_id: note.id,
        rev: note.rev,
        title: note.title,
        body_md: note.body_md,
        tags: (note.tags as string[]) ?? [],
        author,
        reason,
      },
    })

    const deleted_at = new Date()
    await tx.note.update({ where: { id }, data: { deleted_at } })

    return { id, deleted_at }
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
  return revisions.map((r) => ({
    note_id: r.note_id,
    rev: r.rev,
    title: r.title,
    body_md: r.body_md,
    tags: (r.tags as string[] | null) ?? [],
    author: r.author,
    reason: r.reason,
    created_at: r.created_at,
  }))
}

/** Búsqueda léxica (task 1.4) — full-text Postgres español, insensible a tildes. */
export async function lexicalSearch(
  prisma: PrismaClient,
  query: string,
  filter: { app?: string; kind?: string } = {},
): Promise<LexicalResult[]> {
  const appCond = filter.app ? Prisma.sql`AND app = ${filter.app}` : Prisma.empty
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
