import 'dotenv/config';
import path from 'path';

const env = process.env;
const bool = (v: string | undefined, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(v.toLowerCase()));
const int = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

const nodeEnv = env.NODE_ENV || 'development';
const isProd = nodeEnv === 'production';
const isTest = nodeEnv === 'test';

export const config = {
  env: nodeEnv,
  isProd,
  isTest,
  port: int(env.PORT, 4000),
  appUrl: (env.APP_URL || 'http://localhost:5173').replace(/\/$/, ''),
  sessionTtlHours: int(env.SESSION_TTL_HOURS, 12),
  cookieSecure: isProd ? true : bool(env.COOKIE_SECURE, false),
  trustProxy: int(env.TRUST_PROXY, 0),
  uploadDir: path.resolve(env.UPLOAD_DIR || './uploads'),
  maxUploadBytes: int(env.MAX_UPLOAD_MB, 5) * 1024 * 1024,
  serveClient: bool(env.SERVE_CLIENT, false),
  smtp: {
    host: env.SMTP_HOST || '',
    port: int(env.SMTP_PORT, 587),
    user: env.SMTP_USER || '',
    password: env.SMTP_PASSWORD || '',
    from: env.SMTP_FROM || 'Company Accounting <no-reply@localhost>',
  },
  razorpay: {
    keyId: env.RAZORPAY_KEY_ID || '',
    keySecret: env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || '',
  },
  security: {
    passwordMinLength: 10,
    maxFailedLogins: 5,
    lockMinutes: 15,
    resetTokenMinutes: 60,
    inviteTokenHours: 72,
    verifyTokenHours: 48,
  },
};

export function assertProductionConfig() {
  if (!isProd) return;
  const problems: string[] = [];
  if (!env.DATABASE_URL) problems.push('DATABASE_URL is required');
  if (!/^https:\/\//.test(config.appUrl)) problems.push('APP_URL must be an https:// URL in production');
  if (problems.length) throw new Error('Invalid production configuration: ' + problems.join('; '));
}
