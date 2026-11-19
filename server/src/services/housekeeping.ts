import { prisma } from '../db';

/**
 * Removes expired sessions, spent tokens and old idempotency keys.
 * Long-running servers call it hourly (src/index.ts); on Vercel a daily cron job calls
 * GET /api/cron/housekeeping. Expired records are already rejected when used, so this is tidying only.
 */
export async function runHousekeeping() {
  const now = new Date();
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
  const [sessions, resetTokens, verifyTokens, idempotency] = await Promise.all([
    prisma.userSession.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: dayAgo } }] } }),
    prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: dayAgo } } }),
    prisma.emailVerificationToken.deleteMany({ where: { expiresAt: { lt: dayAgo } } }),
    prisma.idempotencyRecord.deleteMany({ where: { createdAt: { lt: dayAgo } } }),
  ]);
  return { sessions: sessions.count, resetTokens: resetTokens.count, verifyTokens: verifyTokens.count, idempotency: idempotency.count };
}
