/**
 * test/search.test.ts — Tasks 2.2, 2.3, 2.4: búsqueda híbrida y duplicados.
 *
 * Fixture de ≥ 20 notas para cubrir los scenarios del spec/busqueda/spec.md:
 *   - Identificador exacto CAR-359 → gana la léxica
 *   - Query conceptual en español → nota correcta top 3 (semántica)
 *   - Filtro app excluye otros dominios
 *   - Duplicados ≥ 0.55 → similar_exists (sin force)
 *   - Duplicados con force → created
 *   - Nota recién creada es encontrable semánticamente (task 2.4)
 *
 * NOTA: el primer beforeAll puede tardar ~5 min si el modelo no está cacheado.
 * Redirigir a archivo: bun test test/search.test.ts 2>&1 | tee test-search.log
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { PrismaClient } from '@prisma/client'
import { createNote } from '../src/db/notes.ts'
import { hybridSearch } from '../src/db/search.ts'
import { warmup } from '../src/db/embeddings.ts'

const prisma = new PrismaClient()

// IDs que usaremos para assertions
let mtd359NoteId = ''
let tasaPreferencialId = ''

/** Fixture mínimo: ≥ 20 notas que cubren los escenarios de búsqueda. */
const FIXTURE = [
  // La nota con el identificador exacto CAR-359
  {
    title: 'Fix ticket CAR-359: validación de RUT en formulario de ingreso',
    body_md:
      'El ticket CAR-359 corrigió la validación del RUT en el formulario de ingreso de clientes al sistema cartera. Se ajustó el regex y se agregaron tests de borde.',
    app: 'cartera',
    kind: 'pitfall' as const,
    tag: 'car-359',
  },
  // Nota conceptual sobre tasa preferencial (para test semántico)
  {
    title: 'Tasa preferencial de clientes',
    body_md:
      'El sistema gestiona descuentos diferenciados para miembros con membresía activa. La tasa preferencial se calcula en base al historial de pagos y la categoría de cliente. Solo los administradores de la financiera pueden modificar este valor.',
    app: 'cartera',
    kind: 'regla' as const,
    tag: 'tasa-pref',
  },
  // Notas adicionales cartera para volumen
  { title: 'Flujo de aprobación de créditos', body_md: 'El flujo de aprobación sigue una cadena de validaciones: ingreso, análisis, comité, desembolso. Cada etapa tiene responsables y plazos definidos en el sistema.', app: 'cartera', kind: 'flujo' as const },
  { title: 'Esquema de roles del sistema', body_md: 'Los roles principales son: administrador, operador, consultor y auditor. Cada rol tiene permisos específicos sobre los módulos del sistema cartera.', app: 'cartera', kind: 'sistema' as const },
  { title: 'Regla de amortización de préstamos', body_md: 'Los préstamos se amortizan con el método francés por defecto. La cuota mensual es fija e incluye capital e intereses calculados sobre saldo.', app: 'cartera', kind: 'regla' as const },
  { title: 'Proceso de cierre contable mensual', body_md: 'El cierre contable se ejecuta el último día hábil del mes. Requiere que todos los comprobantes del período estén aprobados y cuadrados.', app: 'cartera', kind: 'flujo' as const },
  { title: 'Decisión arquitectónica: separación de módulos', body_md: 'Se decidió separar el módulo de crédito del módulo de ahorro en servicios independientes para mejorar la escalabilidad y el mantenimiento.', app: 'cartera', kind: 'decision' as const },
  { title: 'Validación de rut chileno', body_md: 'La validación del RUT incluye el dígito verificador calculado con módulo 11. La función está implementada en el servicio de personas del sistema.', app: 'cartera', kind: 'sistema' as const },
  { title: 'Gestión de garantías', body_md: 'Las garantías pueden ser prendarias o hipotecarias. Se deben registrar antes del desembolso del crédito y tienen fecha de vencimiento configurable.', app: 'cartera', kind: 'sistema' as const },
  { title: 'Reglamento de junta de clientes', body_md: 'La junta ordinaria se realiza dentro de los 90 días del cierre del ejercicio. El quórum mínimo es el 10% de los clientes activos.', app: 'cartera', kind: 'regla' as const },
  // Notas huella para probar filtro de dominio
  { title: 'Lector biométrico modelo FP200', body_md: 'El lector FP200 se conecta por USB y usa el driver libfprint. La captura requiere al menos 3 muestras válidas para enrolamiento en el sistema.', app: 'huella', kind: 'sistema' as const },
  { title: 'Protocolo de enrolamiento biométrico', body_md: 'El enrolamiento se realiza con 5 capturas de huella. Se rechaza si la calidad promedio es menor al 70%. El proceso dura aproximadamente 2 minutos.', app: 'huella', kind: 'flujo' as const },
  { title: 'Pitfall: lector desconectado en producción', body_md: 'Si el lector biométrico se desconecta durante una sesión activa, el sistema muestra error 503. La solución es reconectar y reiniciar el servicio sin reiniciar el servidor.', app: 'huella', kind: 'pitfall' as const },
  { title: 'Umbral de similitud biométrica', body_md: 'El umbral de similitud para reconocimiento está configurado en 0.75. Valores menores aumentan falsos positivos; mayores aumentan falsos negativos.', app: 'huella', kind: 'regla' as const },
  { title: 'Regla de acceso por huella', body_md: 'El acceso a ciertas funciones del sistema requiere verificación biométrica del operador. Esta validación no reemplaza la autenticación por contraseña.', app: 'huella', kind: 'regla' as const },
  // Notas general para volumen
  { title: 'Política de respaldo de base de datos', body_md: 'Los respaldos se realizan cada 6 horas con retención de 30 días. Se almacenan en almacenamiento redundante separado del servidor de producción.', app: 'general', kind: 'regla' as const },
  { title: 'Guía de onboarding para nuevos desarrolladores', body_md: 'El proceso de onboarding incluye configuración del ambiente local, lectura de la documentación de arquitectura y pair programming con un desarrollador senior durante la primera semana.', app: 'general', kind: 'flujo' as const },
  { title: 'Estándares de código del equipo', body_md: 'El código TypeScript sigue las reglas de ESLint strict con Prettier. Los commits siguen Conventional Commits. Se requiere revisión de al menos un par antes del merge.', app: 'general', kind: 'decision' as const },
  { title: 'Gestión de secretos y configuración', body_md: 'Los secretos no se commitean nunca. Se usan archivos .env locales y variables de entorno en CI. Las credenciales de producción están en el vault del equipo.', app: 'general', kind: 'regla' as const },
  { title: 'Proceso de deploy a producción', body_md: 'El deploy requiere aprobación del tech lead y pasa por staging 24 horas antes. Se ejecuta con docker compose en servidor dedicado con monitoreo activo.', app: 'general', kind: 'flujo' as const },
]

beforeAll(async () => {
  // Limpia datos previos
  await prisma.$executeRaw`TRUNCATE notes CASCADE`

  // Precalienta el modelo (el modelo ya puede estar cargado si notes.test corrió antes)
  console.log(`[search.test] Calentando modelo ONNX...`)
  await warmup()
  console.log(`[search.test] Insertando ${FIXTURE.length} notas con embeddings...`)
  const start = Date.now()

  for (let i = 0; i < FIXTURE.length; i++) {
    const f = FIXTURE[i]!
    const tags = 'tag' in f && f.tag ? [f.tag] : []
    const r = await createNote(prisma, {
      title: f.title,
      body_md: f.body_md,
      app: f.app,
      kind: f.kind,
      author: 'fixture',
      tags,
    })
    if (r.status !== 'created') {
      console.warn(`[search.test] Nota ${i} fue detectada como duplicado. Reintentando con force.`)
      const r2 = await createNote(prisma, {
        title: f.title,
        body_md: f.body_md,
        app: f.app,
        kind: f.kind,
        author: 'fixture',
        tags,
        force: true,
      })
      if (r2.status === 'created') {
        if (i === 0) mtd359NoteId = r2.note.id
        if (i === 1) tasaPreferencialId = r2.note.id
      }
    } else {
      if (i === 0) mtd359NoteId = r.note.id
      if (i === 1) tasaPreferencialId = r.note.id
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`[search.test] Fixture listo en ${elapsed}s. CAR-359=${mtd359NoteId}, tasa=${tasaPreferencialId}`)
}, 15 * 60 * 1000) // 15 minutos — cubre descarga del modelo (~420MB) + 20 embeddings

afterAll(async () => {
  await prisma.$disconnect()
})

// ─── Búsqueda híbrida ─────────────────────────────────────────────────────────

describe('hybridSearch — identificador exacto (lexical)', () => {
  test('CAR-359 aparece primero con origin lexical', async () => {
    const results = await hybridSearch(prisma, 'CAR-359')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]!.id).toBe(mtd359NoteId)
    expect(['lexical', 'both']).toContain(results[0]!.origin)
  }, 60_000)
})

describe('hybridSearch — consulta conceptual (semántica)', () => {
  test('paráfrasis de tasa preferencial trae la nota correcta en top 3', async () => {
    // La query no repite palabras exactas del título (prueba semántica)
    const results = await hybridSearch(prisma, 'quién puede modificar el descuento para miembros con membresía')
    const ids = results.slice(0, 3).map((r) => r.id)
    expect(ids).toContain(tasaPreferencialId)
    // Confirma que el resultado tiene origen semántico
    const hit = results.find((r) => r.id === tasaPreferencialId)!
    expect(['semantic', 'both']).toContain(hit.origin)
  }, 60_000)
})

describe('hybridSearch — filtros', () => {
  test('filtro app=cartera excluye notas de huella', async () => {
    const results = await hybridSearch(prisma, 'sistema', { app: 'cartera' })
    expect(results.length).toBeGreaterThan(0)
    // Verificamos que ningún resultado es de huella (consultando la DB)
    if (results.length > 0) {
      const ids = results.map((r) => r.id)
      const bioNotes = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM notes WHERE id = ANY(${ids}::text[]) AND app = 'huella'
      `
      expect(bioNotes.length).toBe(0)
    }
  }, 60_000)
})

// ─── Duplicados (task 2.3) ────────────────────────────────────────────────────

describe('detección de duplicados (task 2.3)', () => {
  test('sin duplicados → status created', async () => {
    const r = await createNote(prisma, {
      title: 'Nota completamente única y original sobre gestión de errores HTTP',
      body_md: 'Esta nota habla de un tema totalmente diferente a las demás. Gestión de códigos de error HTTP 4xx y 5xx en servicios REST del sistema general.',
      app: 'general',
      kind: 'sistema',
      author: 'tester',
    })
    expect(r.status).toBe('created')
  }, 60_000)

  test('con similar ≥ 0.55 sin force → similar_exists con candidatas', async () => {
    // Crea una nota de referencia (force=true para pasar el fixture existente)
    const ref = await createNote(prisma, {
      title: 'Regla de acceso preferencial para clientes fundadores',
      body_md: 'Los clientes fundadores tienen acceso preferencial a créditos con tasas diferenciadas. Este beneficio se gestiona a través del módulo de categorías de clientes en el sistema cartera.',
      app: 'cartera',
      kind: 'regla',
      author: 'tester',
      force: true, // bypass posible similitud con notas del fixture
    })
    if (ref.status !== 'created') throw new Error('No se creó la nota de referencia')

    // Intenta crear nota muy similar
    const r = await createNote(prisma, {
      title: 'Acceso preferencial para clientes fundadores de la financiera',
      body_md: 'Los clientes fundadores tienen acceso preferencial a créditos con tasas diferenciadas. Este beneficio está gestionado por el módulo de categorías en el sistema cartera.',
      app: 'cartera',
      kind: 'regla',
      author: 'tester',
    })
    expect(r.status).toBe('similar_exists')
    if (r.status === 'similar_exists') {
      expect(r.candidates.length).toBeGreaterThan(0)
      expect(r.candidates.every((c) => c.score >= 0.55)).toBe(true)
    }
  }, 90_000)

  test('con similar ≥ 0.55 con force → created', async () => {
    const r = await createNote(prisma, {
      title: 'Acceso preferencial clientes fundadores (duplicado intencional)',
      body_md: 'Los clientes fundadores tienen acceso preferencial a créditos con tasas diferenciadas. Este beneficio está gestionado por el módulo de categorías en el sistema cartera.',
      app: 'cartera',
      kind: 'regla',
      author: 'tester',
      force: true,
    })
    expect(r.status).toBe('created')
    if (r.status === 'created') {
      expect(r.note.id).toBeTruthy()
    }
  }, 90_000)
})

// ─── Embedding en escritura (task 2.4) ───────────────────────────────────────

describe('embedding al crear/actualizar (task 2.4)', () => {
  test('nota recién creada es encontrable semánticamente sin reindexado', async () => {
    // Nota sobre tema único y específico
    // force=true: este test verifica búsqueda semántica, no detección de duplicados
    const r = await createNote(prisma, {
      title: 'Procedimiento de verificación de identidad para operaciones en caja',
      body_md: 'Para operaciones de caja que superen el umbral definido, el cajero debe verificar la identidad del cliente mediante DNI vigente y confirmación visual. El procedimiento está auditado y se registra en el log de transacciones.',
      app: 'cartera',
      kind: 'flujo',
      author: 'tester',
      force: true,
    })
    if (r.status !== 'created') throw new Error('No se pudo crear nota de test')
    const noteId = r.note.id

    // Busca semánticamente con paráfrasis — SIN ninguna operación intermedia de reindexado
    const results = await hybridSearch(prisma, 'cómo verificar al cliente antes de hacer un pago en ventanilla')
    const found = results.some((s) => s.id === noteId)
    expect(found).toBe(true)
  }, 90_000)
})
