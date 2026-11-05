import { PrismaClient } from '@prisma/client'

/** Singleton del cliente Prisma para el proceso. Los tests crean su propia instancia. */
export const prisma = new PrismaClient()
