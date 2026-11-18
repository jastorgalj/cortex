/**
 * test/args.test.ts — Unitarios para src/tools/args.ts.
 * Sin BD, sin servidor; prueba normalizeToolArgs y resolveAuthor.
 */
import { describe, test, expect } from 'bun:test'
import { normalizeToolArgs, resolveAuthor } from '../src/tools/args.ts'

// ─── normalizeToolArgs ────────────────────────────────────────────────────────

describe('normalizeToolArgs', () => {
  test('tool sin alias devuelve el mismo objeto', () => {
    const original = { q: 'x' }
    const result = normalizeToolArgs('cortex_read', original)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.args).toBe(original)
  })

  test('cortex_search: alias query renombrado a q', () => {
    const result = normalizeToolArgs('cortex_search', { query: 'busco algo' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.args.q).toBe('busco algo')
      expect(result.args.query).toBeUndefined()
    }
  })

  test('cortex_search: alias text renombrado a q', () => {
    const result = normalizeToolArgs('cortex_search', { text: 'busco algo' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.args.q).toBe('busco algo')
      expect(result.args.text).toBeUndefined()
    }
  })

  test('cortex_write: alias body renombrado a body_md', () => {
    const result = normalizeToolArgs('cortex_write', { body: 'contenido', app: 'general' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.args.body_md).toBe('contenido')
      expect(result.args.body).toBeUndefined()
    }
  })

  test('cortex_write: alias content renombrado a body_md', () => {
    const result = normalizeToolArgs('cortex_write', { content: 'contenido' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.args.body_md).toBe('contenido')
      expect(result.args.content).toBeUndefined()
    }
  })

  test('cortex_write: alias markdown renombrado a body_md', () => {
    const result = normalizeToolArgs('cortex_write', { markdown: 'contenido' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.args.body_md).toBe('contenido')
      expect(result.args.markdown).toBeUndefined()
    }
  })

  test('cortex_update: alias body renombrado a body_md', () => {
    const result = normalizeToolArgs('cortex_update', { body: 'actualizado', id: 'x' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.args.body_md).toBe('actualizado')
      expect(result.args.body).toBeUndefined()
    }
  })

  test('canónico + alias con mismo valor → ok, alias borrado', () => {
    const result = normalizeToolArgs('cortex_search', { q: 'mismo', query: 'mismo' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.args.q).toBe('mismo')
      expect(result.args.query).toBeUndefined()
    }
  })

  test('canónico + alias con valores distintos → conflicto', () => {
    const result = normalizeToolArgs('cortex_search', { q: 'uno', query: 'dos' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.canonical).toBe('q')
      // a y b son los dos keys que chocan
      const keys = [result.a, result.b].sort()
      expect(keys).toContain('q')
      expect(keys).toContain('query')
    }
  })

  test('dos alias distintos entre sí → conflicto', () => {
    const result = normalizeToolArgs('cortex_search', { query: 'uno', text: 'dos' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.canonical).toBe('q')
    }
  })

  test('argumento undefined no cuenta como presente', () => {
    const result = normalizeToolArgs('cortex_search', { q: 'hola', query: undefined })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.args.q).toBe('hola')
      expect(result.args.query).toBeUndefined()
    }
  })

  test('sin ningún alias presente devuelve mismo objeto', () => {
    const original = { q: 'hola', app: 'general' }
    const result = normalizeToolArgs('cortex_search', original)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.args).toBe(original)
  })

  test('no muta el objeto recibido', () => {
    const original = { query: 'busco' }
    const copy = { ...original }
    normalizeToolArgs('cortex_search', original)
    expect(original).toEqual(copy)
  })
})

// ─── resolveAuthor ────────────────────────────────────────────────────────────

describe('resolveAuthor', () => {
  test('argument gana sobre header y clientName', () => {
    expect(resolveAuthor({ argument: 'juan', header: 'ana', clientName: 'bot' })).toBe('juan')
  })

  test('header gana al cliente cuando no hay argument', () => {
    expect(resolveAuthor({ header: 'ana', clientName: 'mi-cliente' })).toBe('ana')
  })

  test('El nombre del cliente gana cuando header está vacío', () => {
    expect(resolveAuthor({ header: '', clientName: 'mi-cliente' })).toBe('mi-cliente')
  })

  test('El nombre del cliente gana cuando header es solo espacios', () => {
    expect(resolveAuthor({ header: '   ', clientName: 'mi-cliente' })).toBe('mi-cliente')
  })

  test('Sin ninguna fuente devuelve agente', () => {
    expect(resolveAuthor({})).toBe('agente')
  })

  test('clientName vacío cae a agente', () => {
    expect(resolveAuthor({ clientName: '' })).toBe('agente')
  })

  test('clientName con solo espacios cae a agente', () => {
    expect(resolveAuthor({ clientName: '   ' })).toBe('agente')
  })

  test('header como arreglo usa el primer elemento', () => {
    expect(resolveAuthor({ header: ['primero', 'segundo'], clientName: 'bot' })).toBe('primero')
  })

  test('header como arreglo vacío en [0] cae a clientName', () => {
    expect(resolveAuthor({ header: ['', 'segundo'], clientName: 'bot' })).toBe('bot')
  })

  test('Un header en blanco se ignora (sube a clientName)', () => {
    expect(resolveAuthor({ header: '   ', clientName: 'mi-cliente' })).toBe('mi-cliente')
  })
})
