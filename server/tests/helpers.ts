import request from 'supertest';
import crypto from 'crypto';
import type { Express } from 'express';
import { createApp } from '../src/app';
import { prisma } from '../src/db';
import { ensureReferenceData, roleId } from '../src/services/reference';
import { hashPassword } from '../src/lib/tokens';
import { outbox } from '../src/lib/mailer';

export const app: Express = createApp();
export const PASSWORD = 'Str0ng-Passw0rd!';
export { prisma, outbox };

export async function resetDb() {
  if (process.env.NODE_ENV !== 'test') throw new Error('resetDb() may only run under NODE_ENV=test');
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await ensureReferenceData();
  outbox.length = 0;
}

/** A logged-in browser stand-in: keeps the session cookie and echoes the CSRF token. */
export class Client {
  cookie = '';
  csrf = '';
  user: { id: string; email: string; role: string } | null = null;

  private send(method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: unknown, headers: Record<string, string> = {}) {
    let r = request(app)[method](url);
    if (this.cookie) r = r.set('Cookie', this.cookie);
    if (this.csrf && method !== 'get') r = r.set('X-CSRF-Token', this.csrf);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return body !== undefined ? r.send(body as object) : r;
  }
  get(url: string) { return this.send('get', url); }
  post(url: string, body: unknown = {}, headers?: Record<string, string>) { return this.send('post', url, body, headers); }
  patch(url: string, body: unknown = {}) { return this.send('patch', url, body); }

  async login(email: string, password = PASSWORD) {
    const res = await request(app).post('/api/auth/login').send({ email, password });
    if (res.status === 200) {
      this.cookie = (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
      this.csrf = res.body.data.csrfToken;
      this.user = res.body.data.user;
    }
    return res;
  }
}

export const tokenFromMail = (to: string): string => {
  const mail = [...outbox].reverse().find((m) => m.to === to);
  if (!mail) throw new Error(`No mail sent to ${to}`);
  const m = mail.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('No token in mail');
  return m[1];
};

let counter = 0;
export const uniq = (p = 'x') => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

/**
 * Mirrors what `npm run setup:admin` does (creates a verified SUPER_ADMIN with no company),
 * then creates the company through the public API exactly as a real administrator would.
 */
export async function bootstrapCompany(name = 'Acme Traders') {
  const email = `${uniq('owner')}@example.com`;
  await prisma.user.create({ data: { fullName: 'Owner ' + name, email, passwordHash: await hashPassword(PASSWORD), roleId: await roleId('SUPER_ADMIN'), emailVerifiedAt: new Date() } });
  const admin = new Client();
  const login = await admin.login(email);
  if (login.status !== 200) throw new Error('bootstrap login failed: ' + JSON.stringify(login.body));
  const res = await admin.post('/api/company', { name, country: 'India', baseCurrency: 'INR', fyStartMonth: 4 });
  if (res.status !== 201) throw new Error('company create failed: ' + JSON.stringify(res.body));
  const companyId: string = res.body.data.id;
  const accounts = (await admin.get('/api/accounts')).body.data as Array<{ id: string; kind: string; name: string }>;
  const cash = accounts.find((a) => a.kind === 'CASH')!;
  const bankRes = await admin.post('/api/accounts', { kind: 'BANK', name: 'Main Bank', bankName: 'State Bank', bankAccountType: 'CURRENT', accountNumber: '123456789012', openingBalance: '0' });
  if (bankRes.status !== 201) throw new Error('bank create failed: ' + JSON.stringify(bankRes.body));
  const cats = (await admin.get('/api/categories')).body.data as Array<{ id: string; name: string; type: string }>;
  const cat = (n: string) => cats.find((c) => c.name === n)!.id;
  return { admin, email, companyId, cashId: cash.id, bankId: bankRes.body.data.id as string, cat };
}

/** Creates a user the way an administrator does (invite e-mail → set password) and signs them in. */
export async function addUser(admin: Client, role: 'ADMIN' | 'ACCOUNTANT' | 'VIEWER' | 'SUPER_ADMIN') {
  const email = `${uniq(role.toLowerCase())}@example.com`;
  const res = await admin.post('/api/users', { fullName: `Test ${role}`, email, role });
  if (res.status !== 201) throw new Error('user create failed: ' + JSON.stringify(res.body));
  const token = tokenFromMail(email);
  const set = await request(app).post('/api/auth/reset-password').send({ token, password: PASSWORD, confirmPassword: PASSWORD });
  if (set.status !== 200) throw new Error('set password failed: ' + JSON.stringify(set.body));
  const client = new Client();
  const login = await client.login(email);
  if (login.status !== 200) throw new Error('login failed: ' + JSON.stringify(login.body));
  return { client, email, id: res.body.data.id as string };
}

export const idem = () => ({ 'Idempotency-Key': crypto.randomUUID() });
export const today = () => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
};
export const daysAgo = (n: number) => {
  const d = new Date(today() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
