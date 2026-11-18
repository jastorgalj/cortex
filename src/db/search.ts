/**
 * Búsqueda híbrida cortex_search — Decisión 5.
 * FTS (Postgres spanish + unaccent) + semántico (pgvector coseno) en paralelo,
 * fusión por Reciprocal Rank Fusion k=60.
 */
import { type PrismaClient, Prisma } from '@prisma/client'
import { SEMANTIC_DISCARD_THRESHOLD, RRF_K, ISSUE_NORMALIZED_SQL } from './constants.ts'
import { embed } from './embeddings.ts'
import { appFilterValues } from './apps.ts'

export type SearchResult = {
  id: string
  title: string
  snippet: string
  score: number
  origin: 'lexical' | 'semantic' | 'both'
  app: string
  issue: string | null
}

export type SearchFilter = {
  app?: string
  /** Incluir la app transversal `general` al filtrar por `app` (default true). */
  include_general?: boolean
  kind?: string
  issue?: string
  tags?: string[]
}

function extractSnippet(body: string, maxLen = 200): string {
  return body.length <= maxLen ? body : body.substring(0, maxLen) + '…'
}

/** Fusión RRF: dado dos listas ordenadas (lex y vec), combina por rank recíproco. */
function rrfFusion(
  lexItems: { id: string; title: string; body_md: string; app: string; issue: string | null }[],
  vecItems: { id: string; title: string; body_md: string; app: string; issue: string | null }[],
  k: number,
): { id: string; title: string; body_md: string; app: string; issue: string | null; score: number; origin: 'lexical' | 'semantic' | 'both' }[] {
  type Entry = { score: number; title: string; body_md: string; app: string; issue: string | null; inLex: boolean; inVec: boolean }
  const map = new Map<string, Entry>()

  for (let i = 0; i < lexItems.length; i++) {
    const item = lexItems[i]!
    map.set(item.id, { score: 1 / (k + i + 1), title: item.title, body_md: item.body_md, app: item.app, issue: item.issue, inLex: true, inVec: false })
  }

  for (let i = 0; i < vecItems.length; i++) {
    const item = vecItems[i]!
    const existing = map.get(item.id)
    if (existing) {
      map.set(item.id, { ...existing, score: existing.score + 1 / (k + i + 1), inVec: true })
    } else {
      map.set(item.id, { score: 1 / (k + i + 1), title: item.title, body_md: item.body_md, app: item.app, issue: item.issue, inLex: false, inVec: true })
    }
  }

  const result: ReturnType<typeof rrfFusion> = []
  for (const [id, e] of map) {
    result.push({
      id,
      score: e.score,
      title: e.title,
      body_md: e.body_md,
      app: e.app,
      issue: e.issue,
      origin: e.inLex && e.inVec ? 'both' : e.inLex ? 'lexical' : 'semantic',
    })
  }
  result.sort((a, b) => b.score - a.score)
  return result
}

/**
 * Búsqueda híbrida principal — corre FTS y semántico en paralelo, fusiona con RRF.
 * Descarta semánticos con score < SEMANTIC_DISCARD_THRESHOLD antes de fusionar.
 */
export async function hybridSearch(
  prisma: PrismaClient,
  query: string,
  filter: SearchFilter = {},
  limit = 10,
): Promise<SearchResult[]> {
  const appCond = filter.app
    ? Prisma.sql`AND app IN (${Prisma.join(appFilterValues(filter.app, filter.include_general !== false))})`
    : Prisma.empty
  const kindCond = filter.kind ? Prisma.sql`AND kind = ${filter.kind}` : Prisma.empty

  const issueTrimmed = filter.issue?.trim()
  const issueCond = issueTrimmed
    ? Prisma.sql`AND ${ISSUE_NORMALIZED_SQL} = lower(${issueTrimmed})`
    : Prisma.empty

  const tagsCond =
    filter.tags?.length
      ? Prisma.sql`AND tags @> ${JSON.stringify(filter.tags)}::jsonb`
      : Prisma.empty

  const [ftsRows, vecRows] = await Promise.all([
    // Búsqueda léxica
    prisma.$queryRaw<{ id: string; title: string; body_md: string; app: string; issue: string | null }[]>(
      Prisma.sql`
        SELECT id, title, body_md, app, issue
        FROM notes
        WHERE deleted_at IS NULL
          AND fts @@ websearch_to_tsquery('spanish', unaccent(${query}))
          ${appCond}
          ${kindCond}
          ${issueCond}
          ${tagsCond}
        ORDER BY ts_rank(fts, websearch_to_tsquery('spanish', unaccent(${query}))) DESC
        LIMIT 50
      `,
    ),

    // Búsqueda semántica
    (async () => {
      const vector = await embed(query)
      const vecStr = `[${vector.join(',')}]`
      return prisma.$queryRaw<{ id: string; title: string; body_md: string; app: string; issue: string | null; score: number }[]>(
        Prisma.sql`
          SELECT id, title, body_md, app, issue,
                 1 - (embedding <=> ${vecStr}::vector(768)) AS score
          FROM notes
          WHERE deleted_at IS NULL
            AND embedding IS NOT NULL
            AND 1 - (embedding <=> ${vecStr}::vector(768)) >= ${SEMANTIC_DISCARD_THRESHOLD}
            ${appCond}
            ${kindCond}
            ${issueCond}
            ${tagsCond}
          ORDER BY embedding <=> ${vecStr}::vector(768)
          LIMIT 50
        `,
      )
    })(),
  ])

  // Descarte semántico ya aplicado en la query (WHERE score >= threshold)
  // Para claridad tipamos el filtro aquí también
  const vecFiltered = (vecRows as { id: string; title: string; body_md: string; app: string; issue: string | null; score: number }[])
    .filter((r) => Number(r.score) >= SEMANTIC_DISCARD_THRESHOLD)

  const merged = rrfFusion(ftsRows, vecFiltered, RRF_K)

  const sliced = merged.slice(0, limit)

  // Snippet léxico (D6): ts_headline sobre unaccent(body_md) para resultados lexical/both
  const lexIds = sliced.filter((r) => r.origin === 'lexical' || r.origin === 'both').map((r) => r.id)
  const headlineMap = new Map<string, string>()
  if (lexIds.length > 0) {
    const idsLiteral = `{${lexIds.join(',')}}`
    const headlineRows = await prisma.$queryRaw<{ id: string; h: string }[]>(
      Prisma.sql`
        SELECT id, ts_headline('spanish', unaccent(body_md), websearch_to_tsquery('spanish', unaccent(${query})), 'MaxWords=35,MinWords=15,StartSel="",StopSel=""') AS h
        FROM notes
        WHERE id = ANY(${idsLiteral}::text[])
      `,
    )
    for (const row of headlineRows) {
      const h = row.h
      headlineMap.set(row.id, h.length > 400 ? h.substring(0, 400) + '…' : h)
    }
  }

  return sliced.map((r) => ({
    id: r.id,
    title: r.title,
    snippet: headlineMap.has(r.id) ? headlineMap.get(r.id)! : extractSnippet(r.body_md),
    score: r.score,
    origin: r.origin,
    app: r.app,
    issue: r.issue,
  }))
}
