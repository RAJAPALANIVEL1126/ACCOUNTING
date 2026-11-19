import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Vercel's Postgres integrations (e.g. Neon) set DATABASE_URL to a PgBouncer pooled address and
 * DATABASE_URL_UNPOOLED to a direct one. Prisma's interactive transactions and row locks need the direct
 * connection, so it is preferred when present. Everywhere else only DATABASE_URL is used.
 */
export const databaseUrl = () => process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

export const prisma = new PrismaClient({ datasourceUrl: databaseUrl() });
export type Tx = Prisma.TransactionClient;
export { Prisma };
