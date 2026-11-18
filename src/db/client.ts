import { PrismaClient } from '@prisma/client'
import { retryingClient } from './retry.ts'

/** Cliente Prisma sin reintentos — para /health y $disconnect en el cierre. */
export const rawPrisma = new PrismaClient()

/**
 * Cliente Prisma con reintentos automáticos ante fallos transitorios de conexión.
 * Usar en todos los handlers MCP y REST (excepto /health, que debe responder rápido).
 */
export const prisma = retryingClient(rawPrisma) as PrismaClient
