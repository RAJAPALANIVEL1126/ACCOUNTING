import { createApp } from './app';
import { assertProductionConfig, config } from './config';
import { prisma } from './db';
import { log } from './lib/logger';
import { ensureReferenceData } from './services/reference';
import { runHousekeeping } from './services/housekeeping';

async function main() {
  assertProductionConfig();
  await prisma.$connect();
  await ensureReferenceData();

  // Housekeeping: expired sessions, spent tokens and old idempotency keys.
  runHousekeeping().catch((e) => log.warn('Housekeeping failed', { message: e.message }));
  setInterval(() => runHousekeeping().catch(() => undefined), 3600 * 1000).unref();

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
