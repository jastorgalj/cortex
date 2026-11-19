/**
 * test/apps.test.ts — Issue #12: vocabulario de `app`, alias y `general` transversal.
 *
 * Cubre los criterios de aceptación:
 *   - `cortex_list({ kind: "regla", app: "backend" })` devuelve la regla de `general`
 *   - `cortex_search` con `app` aplica la misma regla
 *   - alias configurado → se persiste el canónico; desconocido en `warn` → warnings;
 *     en `strict` → rechazo con la lista válida
 *   - las apps existentes se pueden listar con su conteo
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import {
  createNote,
  listNotes,
  listNotesPage,
  softDeleteNote,
  countNotesByApp,
  ValidationError,
} from '../src/db/notes.ts'
import { hybridSearch } from '../src/db/search.ts'
import { lexicalSearch } from '../src/db/notes.ts'
import { resolveApp, appFilterValues, getAppConfig, GENERAL_APP } from '../src/db/apps.ts'
import { warmup } from '../src/db/embeddings.ts'

const prisma = new PrismaClient()

const VOCAB = { CORTEX_APPS: 'backend,console,general' } as NodeJS.ProcessEnv
const ALIASES = {
  ...VOCAB,
  CORTEX_APP_ALIASES: '{"back":"backend","consola":"console"}',
} as NodeJS.ProcessEnv

beforeAll(async () => {
  await prisma.$executeRaw`TRUNCATE notes CASCADE`
  console.log('[apps.test] Calentando modelo ONNX...')
  await warmup()
}, 15 * 60 * 1000)

afterAll(async () => {
  await prisma.$disconnect()
})

// ─── resolveApp (puro) ────────────────────────────────────────────────────────

describe('resolveApp', () => {
  test('sin vocabulario acepta cualquier app y la normaliza a minúsculas', () => {
    const config = getAppConfig({} as NodeJS.ProcessEnv)
    expect(resolveApp('  Backend ', config)).toEqual({ ok: true, app: 'backend', warnings: [] })
  })

  test('un alias configurado escribe el valor canónico sin warning', () => {
    const config = getAppConfig(ALIASES)
    expect(resolveApp('Back', config)).toEqual({ ok: true, app: 'backend', warnings: [] })
    expect(resolveApp('CONSOLA', config)).toEqual({ ok: true, app: 'console', warnings: [] })
  })

  test('un valor desconocido en modo warn se acepta con warnings', () => {
    const config = getAppConfig({ ...VOCAB, CORTEX_APP_MODE: 'warn' } as NodeJS.ProcessEnv)
    const result = resolveApp('inventada', config)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.app).toBe('inventada')
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toContain('backend')
  })

  test('un valor desconocido en modo strict se rechaza listando los válidos', () => {
    const config = getAppConfig({ ...VOCAB, CORTEX_APP_MODE: 'strict' } as NodeJS.ProcessEnv)
    const result = resolveApp('inventada', config)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('backend')
    expect(result.message).toContain('general')
  })

  test('`general` siempre es válido, también con vocabulario declarado', () => {
    const config = getAppConfig({ CORTEX_APPS: 'backend', CORTEX_APP_MODE: 'strict' } as NodeJS.ProcessEnv)
    expect(resolveApp(GENERAL_APP, config)).toEqual({ ok: true, app: 'general', warnings: [] })
  })
})

// ─── appFilterValues ─────────────────────────────────────────────────────────

describe('appFilterValues', () => {
  test('incluye `general` por defecto y respeta include_general: false', () => {
    const config = getAppConfig(ALIASES)
    expect(appFilterValues('back', true, config).sort()).toEqual(['backend', 'general'])
    expect(appFilterValues('back', false, config)).toEqual(['backend'])
  })

  test('un filtro resuelve alias pero no rechaza valores fuera del vocabulario', () => {
    const config = getAppConfig({ ...VOCAB, CORTEX_APP_MODE: 'strict' } as NodeJS.ProcessEnv)
    expect(appFilterValues('desconocida', false, config)).toEqual(['desconocida'])
  })
})

// ─── Integración con la BD ───────────────────────────────────────────────────

describe('listNotes: `general` es transversal', () => {
  beforeAll(async () => {
    await createNote(prisma, {
      title: 'Regla transversal de commits',
      body_md: 'Regla general: toda custodia de garantías se documenta antes de tocar el backend.',
      app: 'general',
      kind: 'regla',
      author: 'apps-test',
      force: true,
      reason: 'fixture de test',
    })
    await createNote(prisma, {
      title: 'Regla del backend sobre custodia',
      body_md: 'El backend valida la custodia de garantías antes de persistir.',
      app: 'backend',
      kind: 'regla',
      author: 'apps-test',
      force: true,
      reason: 'fixture de test',
    })
  })

  test('filtrar por app trae también las notas de `general`', async () => {
    const notes = await listNotes(prisma, { app: 'backend', kind: 'regla' })
    const apps = notes.map((n) => n.app)
    expect(apps).toContain('backend')
    expect(apps).toContain('general')
  })

  test('include_general: false deja solo la app pedida', async () => {
    const notes = await listNotes(prisma, {
      app: 'backend',
      kind: 'regla',
      include_general: false,
    })
    expect(notes.map((n) => n.app)).toEqual(['backend'])
  })

  test('sin filtro de app lista todas las apps', async () => {
    const notes = await listNotes(prisma, { kind: 'regla' })
    expect(new Set(notes.map((n) => n.app))).toEqual(new Set(['general', 'backend']))
  })
})

describe('hybridSearch: misma regla que el listado', () => {
  test('con app=backend encuentra la nota de general sobre custodia', async () => {
    const results = await hybridSearch(prisma, 'custodia de garantías', { app: 'backend' }, 10)
    const apps = results.map((r) => r.app)
    expect(apps).toContain('general')
    expect(apps).toContain('backend')
  })

  test('include_general: false excluye la nota de general', async () => {
    const results = await hybridSearch(
      prisma,
      'custodia de garantías',
      { app: 'backend', include_general: false },
      10,
    )
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.app === 'backend')).toBe(true)
  })
})

describe('createNote: alias, warn y strict contra la BD', () => {
  const savedEnvs = {
    apps: process.env.CORTEX_APPS,
    aliases: process.env.CORTEX_APP_ALIASES,
    mode: process.env.CORTEX_APP_MODE,
  }

  function setEnv(env: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  afterAll(() => {
    setEnv({
      CORTEX_APPS: savedEnvs.apps,
      CORTEX_APP_ALIASES: savedEnvs.aliases,
      CORTEX_APP_MODE: savedEnvs.mode,
    })
  })

  test('un alias se persiste como su valor canónico', async () => {
    setEnv({ CORTEX_APPS: 'backend,console,general', CORTEX_APP_ALIASES: '{"back":"backend"}', CORTEX_APP_MODE: 'warn' })
    const result = await createNote(prisma, {
      title: 'Nota escrita con alias',
      body_md: 'Se guarda con la app canónica, no con el alias usado al escribir.',
      app: 'Back',
      kind: 'decision',
      author: 'apps-test',
      force: true,
      reason: 'fixture de test',
    })
    expect(result.status).toBe('created')
    if (result.status !== 'created') return
    expect(result.note.app).toBe('backend')
    expect(result.warnings).toEqual([])
  })

  test('un valor desconocido en modo warn se guarda con warnings', async () => {
    setEnv({ CORTEX_APPS: 'backend,general', CORTEX_APP_ALIASES: undefined, CORTEX_APP_MODE: 'warn' })
    const result = await createNote(prisma, {
      title: 'Nota con app fuera del vocabulario',
      body_md: 'Modo warn: se acepta y avisa, para no perder la nota.',
      app: 'inventada',
      kind: 'sistema',
      author: 'apps-test',
      force: true,
      reason: 'fixture de test',
    })
    expect(result.status).toBe('created')
    if (result.status !== 'created') return
    expect(result.note.app).toBe('inventada')
    expect(result.warnings.length).toBe(1)
  })

  test('un valor desconocido en modo strict se rechaza', async () => {
    setEnv({ CORTEX_APPS: 'backend,general', CORTEX_APP_ALIASES: undefined, CORTEX_APP_MODE: 'strict' })
    await expect(
      createNote(prisma, {
        title: 'Nota rechazada por vocabulario',
        body_md: 'Modo strict: la app debe existir en CORTEX_APPS.',
        app: 'inventada',
        kind: 'sistema',
        author: 'apps-test',
        force: true,
        reason: 'fixture de test',
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('countNotesByApp', () => {
  test('cuenta las notas no borradas por app', async () => {
    const rows = await countNotesByApp(prisma)
    const byApp = new Map(rows.map((r) => [r.app, r.count]))
    expect(byApp.get('general')).toBeGreaterThanOrEqual(1)
    expect(byApp.get('backend')).toBeGreaterThanOrEqual(2)
    expect(byApp.get('inventada')).toBe(1)
  })
})

// ─── filtro app en blanco (task 3.4a y 3.4e) ─────────────────────────────────

describe('filtro app en blanco: listNotes y listNotesPage no filtran', () => {
  test('listNotes({ app: "   " }) devuelve el mismo total que sin app', async () => {
    const all = await listNotes(prisma)
    const blank = await listNotes(prisma, { app: '   ' })
    expect(blank.length).toBe(all.length)
  })

  test('listNotesPage({ app: "   " }) devuelve el mismo total que sin app', async () => {
    const all = await listNotesPage(prisma, {}, { limit: 1000, offset: 0 })
    const blank = await listNotesPage(prisma, { app: '   ' }, { limit: 1000, offset: 0 })
    expect(blank.total).toBe(all.total)
  })

  test('hybridSearch({ app: "   " }) devuelve el mismo total que sin app', async () => {
    const all = await hybridSearch(prisma, 'custodia garantías', {}, 100)
    const blank = await hybridSearch(prisma, 'custodia garantías', { app: '   ' }, 100)
    expect(blank.length).toBe(all.length)
  })

  test('lexicalSearch({ app: "   " }) devuelve el mismo total que sin app', async () => {
    const all = await lexicalSearch(prisma, 'custodia')
    const blank = await lexicalSearch(prisma, 'custodia', { app: '   ' })
    expect(blank.length).toBe(all.length)
  })
})

describe('countNotesByApp: no cuenta notas borradas', () => {
  test('una nota borrada lógicamente no aparece en el conteo', async () => {
    const writeResult = await createNote(prisma, {
      title: 'Nota para borrar en test countNotesByApp',
      body_md: 'Cuerpo de nota de test que se va a borrar para verificar conteo.',
      app: 'backend',
      kind: 'regla',
      author: 'apps-test',
      force: true,
      reason: 'fixture borrado',
    })
    if (writeResult.status !== 'created') throw new Error('createNote: esperaba status created')
    const noteId = writeResult.note.id

    const before = await countNotesByApp(prisma)
    const backendBefore = before.find((r) => r.app === 'backend')?.count ?? 0

    await softDeleteNote(prisma, noteId, 'apps-test', 'borrar fixture de test')

    const after = await countNotesByApp(prisma)
    const backendAfter = after.find((r) => r.app === 'backend')?.count ?? 0
    expect(backendAfter).toBe(backendBefore - 1)
  })
})
