import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, app, bootstrapCompany, Client, outbox, PASSWORD, prisma, resetDb, tokenFromMail, uniq } from './helpers';

beforeAll(resetDb);

const signup = (over: Record<string, unknown> = {}) => {
  const email = `${uniq('new')}@example.com`;
  const body = { fullName: 'New Person', email, phone: '+91 98765 43210', password: PASSWORD, confirmPassword: PASSWORD, ...over };
  return { email: String(body.email), send: () => request(app).post('/api/auth/signup').send(body) };
};

describe('registration', () => {
  it('creates a least-privilege account with no company, and never an administrator', async () => {
    // Attempt to smuggle privileged fields through the public endpoint.
    const s = signup({ role: 'SUPER_ADMIN', roleId: 'x', companyId: 'x', isAdmin: true, status: 'ACTIVE', emailVerifiedAt: new Date().toISOString() });
    const res = await s.send();
    expect(res.status).toBe(201);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: s.email }, include: { role: true } });
    expect(user.role.name).toBe('VIEWER');
    expect(user.companyId).toBeNull();
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.passwordHash).not.toContain(PASSWORD);
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/token|hash/i);
  });

  it('validates input', async () => {
    expect((await signup({ email: 'nope' }).send()).status).toBe(400);
    expect((await signup({ password: 'short1', confirmPassword: 'short1' }).send()).status).toBe(400);
    expect((await signup({ password: 'onlyletterslong', confirmPassword: 'onlyletterslong' }).send()).status).toBe(400);
    const mismatch = await signup({ confirmPassword: 'Different-Passw0rd' }).send();
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.details.fields.confirmPassword).toBeTruthy();
    expect((await signup({ phone: 'x' }).send()).status).toBe(400);
  });

  it('does not reveal whether an email is already registered', async () => {
    const s = signup();
    const first = await s.send();
    const again = await s.send();
    expect(again.status).toBe(first.status);
    expect(again.body).toEqual(first.body);
    expect(await prisma.user.count({ where: { email: s.email } })).toBe(1);
  });

  it('requires email verification before sign-in, then works', async () => {
    const s = signup();
    await s.send();
    const c = new Client();
    const blocked = await c.login(s.email);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    const token = tokenFromMail(s.email);
    expect((await request(app).post('/api/auth/verify-email').send({ token: token + 'x' })).status).toBe(400);
    expect((await request(app).post('/api/auth/verify-email').send({ token })).status).toBe(200);
    expect((await request(app).post('/api/auth/verify-email').send({ token })).status).toBe(400); // single use

    const ok = await c.login(s.email);
    expect(ok.status).toBe(200);
    expect(ok.body.data.user.role).toBe('VIEWER');
    expect(ok.body.data.company).toBeNull();
    // A verified but unassigned account can reach no company data at all.
    for (const url of ['/api/transactions', '/api/dashboard/summary', '/api/accounts', '/api/users', '/api/invoices', '/api/audit-logs']) {
      const r = await c.get(url);
      expect(r.status, url).toBe(403);
      expect(r.body.error.code).toBe('NO_COMPANY');
    }
    // ...and cannot create a company (only the setup-created super admin can).
    expect((await c.post('/api/company', { name: 'Hijack Ltd' })).status).toBe(403);
  });
});

describe('login and logout', () => {
  it('signs in with a secure session cookie and signs out', async () => {
    const { admin, email } = await bootstrapCompany('Login Co');
    const res = await new Client().login(email);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|tokenHash/);

    const me = await admin.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(email);
    expect(me.body.data.company.name).toBe('Login Co');
    expect(me.body.data.permissions).toContain('admins.manage');

    expect((await admin.post('/api/auth/logout')).status).toBe(200);
    expect((await admin.get('/api/auth/me')).status).toBe(401); // the server-side session is revoked, not just the cookie
  });

  it('rejects wrong credentials with one generic message', async () => {
    const { email } = await bootstrapCompany('Cred Co');
    const wrongPw = await new Client().login(email, 'Wrong-Passw0rd!');
    const unknown = await new Client().login('nobody@example.com', PASSWORD);
    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrongPw.body.error.message).toBe(unknown.body.error.message);
  });

  it('locks the account after repeated failures', async () => {
    const { email } = await bootstrapCompany('Lock Co');
    for (let i = 0; i < 5; i++) expect((await new Client().login(email, 'Wrong-Passw0rd!')).status).toBe(401);
    const locked = await new Client().login(email); // correct password, but locked
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('refuses deactivated users and kills their sessions', async () => {
    const { admin } = await bootstrapCompany('Deact Co');
    const u = await addUser(admin, 'ACCOUNTANT');
    expect((await u.client.get('/api/transactions')).status).toBe(200);
    expect((await admin.patch(`/api/users/${u.id}/status`, { status: 'INACTIVE' })).status).toBe(200);
    expect((await u.client.get('/api/transactions')).status).toBe(401);
    expect((await new Client().login(u.email)).status).toBe(403);
  });
});

describe('password reset', () => {
  it('resets via a single-use emailed token and revokes existing sessions', async () => {
    const { admin, email } = await bootstrapCompany('Reset Co');
    outbox.length = 0;
    const res = await request(app).post('/api/auth/forgot-password').send({ email });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/token=/);
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: 'ghost@example.com' });
    expect(unknown.body).toEqual(res.body); // no enumeration
    expect(outbox.length).toBe(1);

    const token = tokenFromMail(email);
    const stored = await prisma.passwordResetToken.findFirstOrThrow({ where: { user: { email } }, orderBy: { createdAt: 'desc' } });
    expect(stored.tokenHash).not.toBe(token); // only a hash is stored

    const NEW = 'Brand-New-Passw0rd';
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: 'weak', confirmPassword: 'weak' })).status).toBe(400);
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: NEW, confirmPassword: NEW })).status).toBe(200);
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: NEW, confirmPassword: NEW })).status).toBe(400);
    expect((await admin.get('/api/auth/me')).status).toBe(401);
    expect((await new Client().login(email, PASSWORD)).status).toBe(401);
    expect((await new Client().login(email, NEW)).status).toBe(200);
  });

  it('rejects expired tokens', async () => {
    const { email } = await bootstrapCompany('Expire Co');
    await request(app).post('/api/auth/forgot-password').send({ email });
    const token = tokenFromMail(email);
    await prisma.passwordResetToken.updateMany({ where: { user: { email } }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await request(app).post('/api/auth/reset-password').send({ token, password: PASSWORD, confirmPassword: PASSWORD });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_TOKEN');
  });
});

describe('unauthorised API requests', () => {
  const protectedGets = [
    '/api/auth/me', '/api/company', '/api/dashboard/summary', '/api/dashboard/income-expenses', '/api/dashboard/profit-loss', '/api/dashboard/cash-flow',
    '/api/transactions', '/api/transactions/abc', '/api/income', '/api/expenses', '/api/accounts', '/api/accounts/abc/transactions',
    '/api/reports/daily', '/api/reports/monthly', '/api/reports/profit-loss', '/api/reports/cash-flow', '/api/users', '/api/invoices', '/api/invoices/abc',
    '/api/customers', '/api/suppliers', '/api/payments', '/api/audit-logs', '/api/settings', '/api/categories', '/api/attachments/abc/file', '/api/company/logo',
  ];
  it.each(protectedGets)('GET %s requires authentication', async (url) => {
    const r = await request(app).get(url);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
  });

  const protectedWrites: Array<[string, string]> = [
    ['post', '/api/company'], ['patch', '/api/company'], ['post', '/api/transactions'], ['patch', '/api/transactions/abc'], ['post', '/api/transactions/abc/reverse'],
    ['post', '/api/income'], ['post', '/api/expenses'], ['post', '/api/accounts'], ['post', '/api/users'], ['patch', '/api/users/abc'], ['patch', '/api/users/abc/status'],
    ['post', '/api/invoices'], ['post', '/api/invoices/abc/payments'], ['post', '/api/payments'], ['patch', '/api/settings'], ['post', '/api/auth/logout'],
  ];
  it.each(protectedWrites)('%s %s requires authentication', async (method, url) => {
    const r = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url).send({});
    expect(r.status).toBe(401);
  });

  it('rejects forged or expired session cookies', async () => {
    expect((await request(app).get('/api/transactions').set('Cookie', 'cas_session=' + 'A'.repeat(43))).status).toBe(401);
    const { admin } = await bootstrapCompany('Expired Co');
    await prisma.userSession.updateMany({ where: { userId: admin.user!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await admin.get('/api/transactions')).status).toBe(401);
  });

  it('enforces the CSRF token on state-changing requests', async () => {
    const { admin } = await bootstrapCompany('Csrf Co');
    const noToken = await request(app).patch('/api/company').set('Cookie', admin.cookie).send({ name: 'Changed' });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_INVALID');
    const bad = await request(app).patch('/api/company').set('Cookie', admin.cookie).set('X-CSRF-Token', 'wrong').send({ name: 'Changed' });
    expect(bad.status).toBe(403);
    expect((await admin.get('/api/company')).body.data.name).toBe('Csrf Co');
  });

  it('sends security headers and hides implementation details', async () => {
    const r = await request(app).get('/api/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['x-powered-by']).toBeUndefined();
    const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad json');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.(ts|js)/);
  });
});
