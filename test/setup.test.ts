/**
 * test/setup.test.ts — Task 1.1 verificación: test trivial en verde + DB accesible.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

afterAll(async () => {
  await prisma.$disconnect()
})

describe('setup', () => {
  test('trivial: 1 + 1 = 2', () => {
    expect(1 + 1).toBe(2)
  })

  test('DB accesible y esquema aplicado', async () => {
    // Verifica que las tablas existen
    const result = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('notes', 'note_revisions')
      ORDER BY tablename
    `
    expect(result.map((r) => r.tablename).sort()).toEqual(['note_revisions', 'notes'])
  })

  test('extensión vector disponible', async () => {
    const result = await prisma.$queryRaw<{ extname: string }[]>`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `
    expect(result.length).toBe(1)
  })

  test('trigger FTS existe sobre notes', async () => {
    const result = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'notes'::regclass
        AND tgname = 'notes_fts_trigger'
    `
    expect(result.length).toBe(1)
  })
})
