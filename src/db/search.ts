/**
 * Búsqueda híbrida cortex_search — Decisión 5.
 * FTS (Postgres spanish + unaccent) + semántico (pgvector coseno) en paralelo,
 * fusión por Reciprocal Rank Fusion k=60.
 */
import { type PrismaClient, Prisma } from '@prisma/client'
import { SEMANTIC_DISCARD_THRESHOLD, RRF_K, ISSUE_NORMALIZED_SQL } from './constants.ts'
import { embed } from './embeddings.ts'

export type SearchResult = {
  id: string
  title: string
  snippet: string
  score: number
  origin: 'lexical' | 'semantic' | 'both'
  issue: string | null
}

export type SearchFilter = {
  app?: string
  kind?: string
  issue?: string
  tags?: string[]
}

function extractSnippet(body: string, maxLen = 200): string {
  return body.length <= maxLen ? body : body.substring(0, maxLen) + '…'
}

/** Fusión RRF: dado dos listas ordenadas (lex y vec), combina por rank recíproco. */
function rrfFusion(
  lexItems: { id: string; title: string; body_md: string; issue: string | null }[],
  vecItems: { id: string; title: string; body_md: string; issue: string | null }[],
  k: number,
): { id: string; title: string; body_md: string; issue: string | null; score: number; origin: 'lexical' | 'semantic' | 'both' }[] {
  type Entry = { score: number; title: string; body_md: string; issue: string | null; inLex: boolean; inVec: boolean }
  const map = new Map<string, Entry>()

  for (let i = 0; i < lexItems.length; i++) {
    const item = lexItems[i]!
    map.set(item.id, { score: 1 / (k + i + 1), title: item.title, body_md: item.body_md, issue: item.issue, inLex: true, inVec: false })
  }

  for (let i = 0; i < vecItems.length; i++) {
    const item = vecItems[i]!
    const existing = map.get(item.id)
    if (existing) {
      map.set(item.id, { ...existing, score: existing.score + 1 / (k + i + 1), inVec: true })
    } else {
      map.set(item.id, { score: 1 / (k + i + 1), title: item.title, body_md: item.body_md, issue: item.issue, inLex: false, inVec: true })
    }
  }

  const result: ReturnType<typeof rrfFusion> = []
  for (const [id, e] of map) {
    result.push({
      id,
      score: e.score,
      title: e.title,
      body_md: e.body_md,
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
  const appCond = filter.app ? Prisma.sql`AND app = ${filter.app}` : Prisma.empty
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
    prisma.$queryRaw<{ id: string; title: string; body_md: string; issue: string | null }[]>(
      Prisma.sql`
        SELECT id, title, body_md, issue
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
      return prisma.$queryRaw<{ id: string; title: string; body_md: string; issue: string | null; score: number }[]>(
        Prisma.sql`
          SELECT id, title, body_md, issue,
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
  const vecFiltered = (vecRows as { id: string; title: string; body_md: string; issue: string | null; score: number }[])
    .filter((r) => Number(r.score) >= SEMANTIC_DISCARD_THRESHOLD)

  const merged = rrfFusion(ftsRows, vecFiltered, RRF_K)

  return merged.slice(0, limit).map((r) => ({
    id: r.id,
    title: r.title,
    snippet: extractSnippet(r.body_md),
    score: r.score,
    origin: r.origin,
    issue: r.issue,
  }))
}
