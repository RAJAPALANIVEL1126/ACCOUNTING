import express from 'express';
import type { RequestHandler } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { loadSession, h } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error';
import { authRouter } from './routes/auth';
import { companyRouter } from './routes/company';
import { usersRouter } from './routes/users';
import { categoriesRouter, settingsRouter, taxRatesRouter } from './routes/settings';
import { accountsRouter } from './routes/accounts';
import { expensesRouter, incomeRouter, transactionsRouter } from './routes/transactions';
import { customersRouter, suppliersRouter } from './routes/contacts';
import { invoicesRouter } from './routes/invoices';
import { paymentsRouter, razorpayWebhook } from './routes/payments';
import { dashboardRouter } from './routes/dashboard';
import { auditRouter, reportsRouter } from './routes/reports';
import { attachmentsRouter } from './routes/attachments';
import { prisma } from './db';
import { safeEqual } from './lib/tokens';
import { runHousekeeping } from './services/housekeeping';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", 'https://checkout.razorpay.com'],
          'frame-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
          'connect-src': ["'self'", 'https://api.razorpay.com', 'https://lumberjack.razorpay.com'],
          'img-src': ["'self'", 'data:', 'blob:'],
          'style-src': ["'self'", "'unsafe-inline'"],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  // CORS: only the configured web origin, with credentials. Same-origin requests need no CORS headers at all.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin === config.appUrl) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Idempotency-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(origin === config.appUrl ? 204 : 403);
    next();
  });

  const noLimit: RequestHandler = (_req, _res, next) => next();
  const limiter = (max: number, windowMin = 15) =>
    config.isTest
      ? noLimit
      : rateLimit({ windowMs: windowMin * 60 * 1000, limit: max, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait and try again.' } } });

  // Webhook: raw body (needed for signature verification), no cookies, no CSRF — authenticated by HMAC signature.
  app.post('/api/webhooks/razorpay', limiter(300, 1), express.raw({ type: '*/*', limit: '1mb' }), (req, _res, next) => {
    req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    next();
  }, h(razorpayWebhook));

  app.use('/api', limiter(900));
  app.use(express.json({ limit: '3mb' }));
  app.use(cookieParser());
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', loadSession);

  // Scheduled cleanup for serverless hosts. Vercel Cron sends "Authorization: Bearer <CRON_SECRET>".
  app.get('/api/cron/housekeeping', h(async (req, res) => {
    const secret = process.env.CRON_SECRET;
    const sent = req.headers.authorization ?? '';
    if (!secret || !safeEqual(sent, `Bearer ${secret}`)) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid cron secret' } });
    }
    res.json({ data: { removed: await runHousekeeping() } });
  }));

  app.get('/api/health', h(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ data: { status: 'ok' } });
  }));

  const authLimiter = limiter(30);
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/signup', authLimiter);
  app.use('/api/auth/forgot-password', authLimiter);
  app.use('/api/auth/reset-password', authLimiter);
  app.use('/api/auth/resend-verification', authLimiter);
  app.use('/api/auth/verify-email', authLimiter);

  app.use('/api/auth', authRouter);
  app.use('/api/company', companyRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/tax-rates', taxRatesRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/income', incomeRouter);
  app.use('/api/expenses', expensesRouter);
  app.use('/api/customers', customersRouter);
  app.use('/api/suppliers', suppliersRouter);
  app.use('/api/invoices', invoicesRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/audit-logs', auditRouter);
  app.use('/api/attachments', attachmentsRouter);
  app.use('/api', notFoundHandler);

  // Optional single-host deployment: serve the built web client from this process.
  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (config.serveClient && fs.existsSync(path.join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
