import { createApp } from './app';
import { assertProductionConfig, config } from './config';
import { prisma } from './db';
import { log } from './lib/logger';
import { ensureReferenceData } from './services/reference';

async function main() {
  assertProductionConfig();
  await prisma.$connect();
  await ensureReferenceData();

  // Housekeeping: expired sessions, spent tokens and old idempotency keys.
  const sweep = async () => {
    const now = new Date();
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    await prisma.userSession.deleteMany({ where: { OR: [{ expiresAt: { lt: now } }, { revokedAt: { lt: dayAgo } }] } });
    await prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: dayAgo } } });
    await prisma.emailVerificationToken.deleteMany({ where: { expiresAt: { lt: dayAgo } } });
    await prisma.idempotencyRecord.deleteMany({ where: { createdAt: { lt: dayAgo } } });
  };
  sweep().catch((e) => log.warn('Housekeeping failed', { message: e.message }));
  setInterval(() => sweep().catch(() => undefined), 3600 * 1000).unref();

  const server = createApp().listen(config.port, () => log.info(`API listening on port ${config.port} (${config.env})`));
  const shutdown = () => {
    server.close(() => prisma.$disconnect().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error('Failed to start', { message: e.message });
  process.exit(1);
});
