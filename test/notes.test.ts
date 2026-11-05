/**
 * test/notes.test.ts — Tasks 1.3 y 1.4: CRUD notas + búsqueda léxica.
 *
 * Cubre los scenarios obligatorios del spec:
 *   - Escritura sin autor rechazada
 *   - kind fuera del enum rechazado
 *   - Dos actualizaciones producen dos revisiones
 *   - Actualización con base_rev desactualizada rechazada
 *   - Nota borrada desaparece de los listados
 *   - Búsqueda léxica insensible a tildes
 *   - Nota borrada desaparece de FTS
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import {
  createNote,
  readNote,
  updateNote,
  listNotes,
  softDeleteNote,
  getNoteHistory,
  lexicalSearch,
  ValidationError,
  NotFoundError,
  ConflictError,
} from '../src/db/notes.ts'
import { warmup } from '../src/db/embeddings.ts'

const prisma = new PrismaClient()

beforeAll(async () => {
  // Limpia datos, mantiene el esquema
  await prisma.$executeRaw`TRUNCATE notes CASCADE`
  // Precalienta el modelo ONNX (descarga ~420MB en primera ejecución)
  console.log('[notes.test] Calentando modelo ONNX...')
  await warmup()
  console.log('[notes.test] Modelo listo.')
}, 15 * 60 * 1000) // 15 min — cubre primera descarga del modelo

afterAll(async () => {
  await prisma.$disconnect()
})

// ─── createNote ───────────────────────────────────────────────────────────────

describe('createNote', () => {
  test('crea nota válida con rev=1', async () => {
    const result = await createNote(prisma, {
      title: 'Configuración del módulo de préstamos hipotecarios UF',
      body_md: 'El módulo hipotecario requiere configurar el índice UF diario, el plazo máximo de 30 años y la tabla de tasas según perfil de riesgo del solicitante en la financiera. Este proceso incluye verificación en la central de riesgo.',
      app: 'cartera',
      kind: 'sistema',
      author: 'tester',
      tags: ['test'],
    })
    expect(result.status).toBe('created')
    if (result.status === 'created') {
      expect(result.note.id).toBeTruthy()
      expect(result.note.id.length).toBe(26) // ULID = 26 chars
      expect(result.note.rev).toBe(1)
      expect(result.note.tags).toEqual(['test'])
      expect(result.note.deleted_at).toBeNull()
    }
  }, 30_000)

  test('rechaza author vacío — indica campo author', async () => {
    await expect(
      createNote(prisma, {
        title: 'Test',
        body_md: 'Test content del sistema cartera',
        app: 'cartera',
        kind: 'sistema',
        author: '',
      }),
    ).rejects.toMatchObject({ name: 'ValidationError', field: 'author' })
  }, 60_000)

  test('rechaza author en blanco — indica campo author', async () => {
    await expect(
      createNote(prisma, {
        title: 'Test',
        body_md: 'Test content',
        app: 'cartera',
        kind: 'sistema',
        author: '   ',
      }),
    ).rejects.toMatchObject({ name: 'ValidationError', field: 'author' })
  }, 60_000)

  test('rechaza kind fuera del enum — mensaje nombra los valores válidos', async () => {
    // ValidationError lanzado en validateCreate ANTES de embed() — síncrono, sin I/O
    let caughtErr: unknown = null
    try {
      await createNote(prisma, {
        title: 'Test',
        body_md: 'Test content del sistema cartera para prueba',
        app: 'cartera',
        kind: 'nota-rapida',
        author: 'tester',
      })
    } catch (err) {
      caughtErr = err
    }
    expect(caughtErr).toBeInstanceOf(ValidationError)
    const e = caughtErr as ValidationError
    expect(e.field).toBe('kind')
    expect(e.message).toContain('nota-rapida')
    expect(e.message).toContain('sistema')
    expect(e.message).toContain('pitfall')
  }, 60_000)
})

// ─── readNote ─────────────────────────────────────────────────────────────────

describe('readNote', () => {
  test('lee nota existente', async () => {
    const r = await createNote(prisma, {
      title: 'Nota de lectura',
      body_md: 'Cuerpo de la nota de lectura para el sistema.',
      app: 'cartera',
      kind: 'flujo',
      author: 'tester',
    })
    if (r.status !== 'created') throw new Error('No se creó')

    const note = await readNote(prisma, r.note.id)
    expect(note.id).toBe(r.note.id)
    expect(note.title).toBe('Nota de lectura')
    expect(note.is_deleted).toBeUndefined()
  }, 60_000)

  test('lanza NotFoundError para id inexistente', async () => {
    await expect(readNote(prisma, '01NONEXISTENT0000000000000')).rejects.toBeInstanceOf(NotFoundError)
  })
})

// ─── updateNote ───────────────────────────────────────────────────────────────

describe('updateNote', () => {
  test('update de nota inexistente lanza NotFoundError', async () => {
    await expect(
      updateNote(prisma, '01NONEXISTENT0000000000000', { author: 'tester' }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  test('dos updates producen revisiones 1 y 2 con cuerpos anteriores', async () => {
    const r = await createNote(prisma, {
      title: 'Reglamento de junta extraordinaria de accionistas de financiera regional',
      body_md: 'La junta extraordinaria de accionistas debe convocarse con 15 días de anticipación mediante citación escrita certificada. El quórum reglamentario es del 60 por ciento de los delegados elegidos en representación proporcional.',
      app: 'cartera',
      kind: 'decision',
      author: 'autor-original',
    })
    if (r.status !== 'created') throw new Error('No se creó')
    const id = r.note.id

    // Primera actualización
    await updateNote(prisma, id, {
      body_md: 'La junta extraordinaria requiere citación con 15 días de anticipación. El quórum fue ajustado al 70 por ciento por resolución del directorio en sesión extraordinaria del 2026-10-01.',
      author: 'autor-uno',
      reason: 'primera revisión',
    })

    // Segunda actualización
    await updateNote(prisma, id, {
      body_md: 'La junta extraordinaria requiere citación con 20 días de anticipación según nueva normativa financiera nacional. El quórum se mantiene en 70 por ciento con representación proporcional.',
      author: 'autor-dos',
      reason: 'segunda revisión',
    })

    const history = await getNoteHistory(prisma, id)
    expect(history).toHaveLength(2)
    expect(history[0]!.rev).toBe(1)
    expect(history[1]!.rev).toBe(2)
    // Rev 1 tiene el cuerpo original
    expect(history[0]!.body_md).toContain('60 por ciento')
    expect(history[0]!.author).toBe('autor-original')
    // Rev 2 tiene el cuerpo del primer update
    expect(history[1]!.body_md).toContain('70 por ciento')
    // La nota vigente tiene el cuerpo de la segunda actualización
    const note = await readNote(prisma, id)
    expect(note.rev).toBe(3)
    expect(note.body_md).toContain('20 días')
  }, 90_000)

  test('base_rev desactualizada → rechazo con rev vigente informada', async () => {
    const r = await createNote(prisma, {
      title: 'Procedimiento de rotación de credenciales del servicio de notificaciones',
      body_md: 'Las credenciales del servicio de notificaciones se rotan cada noventa días mediante un job programado que publica la nueva clave en el gestor de secretos y deja la anterior válida por una ventana de gracia de veinticuatro horas.',
      app: 'cartera',
      kind: 'regla',
      author: 'autor-a',
    })
    if (r.status !== 'created') throw new Error('No se creó')
    const id = r.note.id

    // Actualiza → rev pasa a 2
    await updateNote(prisma, id, {
      body_md: 'Las credenciales del servicio de notificaciones se rotan cada sesenta días mediante un job programado que publica la nueva clave en el gestor de secretos y deja la anterior válida por una ventana de gracia de doce horas.',
      author: 'autor-b',
    })

    // Intenta actualizar con base_rev=1 cuando ya es 2
    let caughtErr: unknown = null
    try {
      await updateNote(prisma, id, { body_md: 'Intento fallido.', author: 'autor-a', base_rev: 1 })
    } catch (err) {
      caughtErr = err
    }
    expect(caughtErr).toBeInstanceOf(ConflictError)
    expect((caughtErr as ConflictError).current_rev).toBe(2)
    expect((caughtErr as ConflictError).message).toContain('2')
  }, 90_000)

  test('dos updates concurrentes con base_rev: uno gana y el otro recibe ConflictError', async () => {
    const r = await createNote(prisma, {
      title: 'Concurrencia sobre una nota compartida',
      body_md: 'Cuerpo inicial de la nota que van a actualizar dos procesos a la vez.',
      app: 'general',
      kind: 'otro',
      author: 'autor-a',
      force: true, // evita el aviso de similitud con otras notas del mismo suite
    })
    if (r.status !== 'created') throw new Error('No se creó')
    const id = r.note.id

    const results = await Promise.allSettled([
      updateNote(prisma, id, { body_md: 'Cambio A.', author: 'autor-a', base_rev: 1 }),
      updateNote(prisma, id, { body_md: 'Cambio B.', author: 'autor-b', base_rev: 1 }),
    ])

    const ok = results.filter((x) => x.status === 'fulfilled')
    const failed = results.filter((x) => x.status === 'rejected')
    expect(ok.length).toBe(1)
    expect(failed.length).toBe(1)
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError)

    // La nota quedó en rev 2 (una sola escritura aplicada) y con historial de la versión previa
    const after = await readNote(prisma, id)
    expect(after.rev).toBe(2)
    const history = await getNoteHistory(prisma, id)
    expect(history.length).toBe(1)
  }, 90_000)
})

// ─── softDelete / list ────────────────────────────────────────────────────────

describe('softDelete', () => {
  test('nota borrada desaparece de list y search, readable con is_deleted', async () => {
    const r = await createNote(prisma, {
      title: 'Inventario de equipos de red del centro de datos secundario de respaldo',
      body_md: 'El centro de datos secundario cuenta con cuatro switches core 48 puertos, dos routers de borde activo-pasivo y dieciséis servidores blade con conexión 10GbE de fibra óptica monomodo verificada anualmente.',
      app: 'general',
      kind: 'sistema',
      author: 'tester',
    })
    if (r.status !== 'created') throw new Error('No se creó')
    const id = r.note.id

    // Aparece en list
    const before = await listNotes(prisma, { app: 'general' })
    expect(before.some((n) => n.id === id)).toBe(true)

    // Borrado lógico
    await softDeleteNote(prisma, id, 'test-author', 'borrado en test')

    // Ya no aparece en list
    const after = await listNotes(prisma, { app: 'general' })
    expect(after.some((n) => n.id === id)).toBe(false)

    // readNote indica que está borrada
    const deleted = await readNote(prisma, id)
    expect(deleted.is_deleted).toBe(true)
  }, 60_000)
})

// ─── softDelete: revisión avanzada y recuperación ─────────────────────────────

describe('softDelete — la revisión avanza y la nota recuperada se puede actualizar', () => {
  test('borrar una nota en rev 3 → readNote is_deleted con rev 4 y ninguna revisión usa el 4', async () => {
    const r = await createNote(prisma, {
      title: 'Bitácora de incidentes del turno nocturno del centro de monitoreo',
      body_md: 'El turno nocturno registra cada incidente con hora de detección, servicio afectado y responsable de la mitigación. Los incidentes críticos se escalan de inmediato al coordinador de guardia.',
      app: 'bitacora',
      kind: 'flujo',
      author: 'autor-inicial',
      force: true,
    })
    if (r.status !== 'created') throw new Error('No se creó')
    const id = r.note.id

    await updateNote(prisma, id, {
      body_md: 'El turno nocturno registra cada incidente con hora de detección, servicio afectado, severidad y responsable de la mitigación. Los críticos se escalan al coordinador de guardia en menos de cinco minutos.',
      author: 'autor-uno',
    })
    await updateNote(prisma, id, {
      body_md: 'El turno nocturno registra cada incidente con hora de detección, servicio afectado, severidad y responsable de la mitigación. Los críticos se escalan al coordinador de guardia en menos de cinco minutos, con aviso al jefe de operaciones.',
      author: 'autor-dos',
    })

    const before = await readNote(prisma, id)
    expect(before.rev).toBe(3)

    const result = await softDeleteNote(prisma, id, 'quien-borra', 'nota obsoleta')
    expect(result.rev).toBe(4)

    const after = await readNote(prisma, id)
    expect(after.is_deleted).toBe(true)
    expect(after.rev).toBe(4)

    const history = await getNoteHistory(prisma, id)
    expect(history.map((h) => h.rev)).toEqual([1, 2, 3])
  }, 90_000)

  test('regresión: borrar, recuperar y actualizar no colisiona con el PK (note_id, rev)', async () => {
    const r = await createNote(prisma, {
      title: 'Instructivo de respaldo diario de la base operacional del núcleo',
      body_md: 'El respaldo diario de la base operacional se ejecuta a las 02:00 y se retiene por treinta días en almacenamiento externo con cifrado en reposo y verificación de integridad semanal.',
      app: 'nucleo-core',
      kind: 'sistema',
      author: 'autor-original',
      force: true,
    })
    if (r.status !== 'created') throw new Error('No se creó')
    const id = r.note.id

    // Una actualización → rev 2
    await updateNote(prisma, id, {
      body_md: 'El respaldo diario de la base operacional se ejecuta a las 01:30 y se retiene por treinta días en almacenamiento externo con cifrado en reposo y verificación de integridad semanal.',
      author: 'autor-uno',
    })

    // Borrar: la revisión final queda en 2 y la nota avanza a 3 (el avance lo
    // prueba el test anterior; acá solo importa que el número quede libre)
    const deleted = await softDeleteNote(prisma, id, 'autor-borrador', 'duplicada')
    expect(deleted.deleted_at).toBeTruthy()

    // Recuperar la nota (no hay tool de restauración todavía: se limpia deleted_at)
    await prisma.$executeRaw`UPDATE notes SET deleted_at = NULL WHERE id = ${id}`

    const restored = await readNote(prisma, id)
    expect(restored.is_deleted).toBeUndefined()

    // La actualización con el base_rev de la revisión vigente funciona y deja la
    // revisión siguiente. Con el defecto, restored.rev sigue siendo 2 (la revisión
    // final del borrado) y el INSERT choca con el PK (note_id, rev).
    const updated = await updateNote(prisma, id, {
      body_md: 'El respaldo diario de la base operacional se ejecuta a las 01:30 y se retiene por cuarenta y cinco días en almacenamiento externo con cifrado en reposo y verificación de integridad semanal.',
      author: 'autor-dos',
      base_rev: restored.rev,
    })
    expect(updated.rev).toBe(4)
    expect(updated.body_md).toContain('cuarenta y cinco días')

    const history = await getNoteHistory(prisma, id)
    expect(history.map((h) => h.rev)).toEqual([1, 2, 3])
  }, 90_000)
})

// ─── listNotes filtros ────────────────────────────────────────────────────────

describe('listNotes', () => {
  test('filtro app excluye otras apps', async () => {
    // Asegurar nota con app=huella
    await createNote(prisma, {
      title: 'Protocolo de calibración de sensor dactilar en puntos de control de acceso físico',
      body_md: 'La calibración del sensor dactilar se realiza con plantilla maestra certificada y se verifica con diez muestras de control de calidad. La frecuencia recomendada es mensual o tras cincuenta mil lecturas acumuladas en el dispositivo biométrico.',
      app: 'huella',
      kind: 'sistema',
      author: 'tester',
    })

    const dfNotes = await listNotes(prisma, { app: 'cartera' })
    expect(dfNotes.every((n) => n.app === 'cartera')).toBe(true)

    const bioNotes = await listNotes(prisma, { app: 'huella' })
    expect(bioNotes.every((n) => n.app === 'huella')).toBe(true)
  }, 60_000)

  test('filtro kind=regla devuelve solo reglas', async () => {
    // force para evitar bloqueo por similitud si ya existe una nota parecida
    const r = await createNote(prisma, {
      title: 'Regla de amortización anticipada de préstamos prendarios sin comisión',
      body_md: 'Los clientes pueden realizar prepagos parciales de préstamos prendarios sin comisión adicional, siempre que el monto sea múltiplo de la cuota mensual y se notifique con cinco días hábiles de anticipación por escrito a la financiera.',
      app: 'cartera',
      kind: 'regla',
      author: 'tester',
      force: true,
    })
    if (r.status !== 'created') throw new Error('No se creó')

    const reglas = await listNotes(prisma, { app: 'cartera', kind: 'regla' })
    expect(reglas.length).toBeGreaterThan(0)
    expect(reglas.every((n) => n.kind === 'regla' && n.app === 'cartera')).toBe(true)
  }, 60_000)
})

// ─── lexicalSearch (task 1.4) ─────────────────────────────────────────────────

describe('lexicalSearch (task 1.4)', () => {
  test('query con tilde y sin tilde encuentran la misma nota', async () => {
    // force=true: los tests lexicales no prueban detección de duplicados
    const r = await createNote(prisma, {
      title: 'Proceso de evaluación técnica de solicitudes de crédito hipotecario',
      body_md: 'La evaluación técnica de solicitudes de crédito hipotecario incluye tasación del inmueble, revisión de escrituras y verificación de deuda en central de riesgo. El plazo máximo de evaluación es de quince días hábiles contados desde la recepción.',
      app: 'cartera',
      kind: 'flujo',
      author: 'tester',
      force: true,
    })
    if (r.status !== 'created') throw new Error('No se creó')
    const id = r.note.id

    // Busca CON tilde
    const withAccent = await lexicalSearch(prisma, 'evaluación')
    const withIds = withAccent.map((r) => r.id)

    // Busca SIN tilde
    const withoutAccent = await lexicalSearch(prisma, 'evaluacion')
    const withoutIds = withoutAccent.map((r) => r.id)

    expect(withIds).toContain(id)
    expect(withoutIds).toContain(id)
  }, 60_000)

  test('nota borrada (soft) desaparece de FTS', async () => {
    const uniq = `codigounico${Date.now()}`
    const r = await createNote(prisma, {
      title: `Nota FTS borrado ${uniq}`,
      body_md: `Esta nota tiene el código único ${uniq} para verificar su desaparición del índice FTS tras el borrado lógico en el sistema.`,
      app: 'cartera',
      kind: 'otro',
      author: 'tester',
      force: true,  // evita bloqueo por similitud con otras notas del mismo suite
    })
    if (r.status !== 'created') throw new Error('No se creó')
    const id = r.note.id

    // Aparece en búsqueda
    const before = await lexicalSearch(prisma, uniq)
    expect(before.some((r) => r.id === id)).toBe(true)

    // Borrar y verificar que desaparece
    await softDeleteNote(prisma, id, 'test-author', 'borrado en test')
    const after = await lexicalSearch(prisma, uniq)
    expect(after.some((r) => r.id === id)).toBe(false)
  }, 60_000)
})
