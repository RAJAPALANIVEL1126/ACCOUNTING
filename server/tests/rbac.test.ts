import { beforeAll, describe, expect, it } from 'vitest';
import { addUser, bootstrapCompany, Client, idem, prisma, resetDb, today } from './helpers';

type Ctx = Awaited<ReturnType<typeof bootstrapCompany>>;
let a: Ctx, b: Ctx;
let adminA: Client, accountant: Client, viewer: Client;
let accountantId: string, adminAId: string;

beforeAll(async () => {
  await resetDb();
  a = await bootstrapCompany('Alpha Pvt Ltd');
  b = await bootstrapCompany('Beta Pvt Ltd');
  const ad = await addUser(a.admin, 'ADMIN');
  adminA = ad.client; adminAId = ad.id;
  const ac = await addUser(a.admin, 'ACCOUNTANT');
  accountant = ac.client; accountantId = ac.id;
  viewer = (await addUser(a.admin, 'VIEWER')).client;
});

const income = (c: Ctx, amount = '1000.00') => ({ date: today(), categoryId: c.cat('Product Sales'), amount, paymentMethod: 'CASH', accountId: c.cashId, description: 'Counter sale' });

describe('role permissions', () => {
  it('viewer can read but cannot write anything', async () => {
    expect((await viewer.get('/api/transactions')).status).toBe(200);
    expect((await viewer.get('/api/dashboard/summary')).status).toBe(200);
    expect((await viewer.get('/api/reports/profit-loss')).status).toBe(200);
    expect((await viewer.post('/api/income', income(a))).status).toBe(403);
    expect((await viewer.post('/api/expenses', {})).status).toBe(403);
    expect((await viewer.post('/api/invoices', {})).status).toBe(403);
    expect((await viewer.post('/api/customers', { name: 'X Y' })).status).toBe(403);
    expect((await viewer.post('/api/accounts', { kind: 'CASH', name: 'Petty' })).status).toBe(403);
    expect((await viewer.patch('/api/company', { name: 'Nope' })).status).toBe(403);
    expect((await viewer.get('/api/reports/profit-loss?format=csv')).status).toBe(403); // no export right
    expect((await viewer.get('/api/users')).status).toBe(403);
    expect((await viewer.get('/api/audit-logs')).status).toBe(403);
  });

  it('accountant records transactions but has no administrative access', async () => {
    const res = await accountant.post('/api/income', income(a));
    expect(res.status).toBe(201);
    expect((await accountant.get('/api/reports/profit-loss?format=csv')).status).toBe(200);
    expect((await accountant.get('/api/users')).status).toBe(403);
    expect((await accountant.post('/api/users', { fullName: 'Sneaky Admin', email: 'sneaky@example.com', role: 'ADMIN' })).status).toBe(403);
    expect((await accountant.patch('/api/settings', { accountingMethod: 'CASH' })).status).toBe(403);
    expect((await accountant.patch('/api/company', { name: 'Nope' })).status).toBe(403);
    expect((await accountant.get('/api/audit-logs')).status).toBe(403);
    expect((await accountant.post(`/api/transactions/${res.body.data.id}/reverse`, { reason: 'I want to undo this' })).status).toBe(403);
    expect((await accountant.post('/api/transactions', { type: 'ADJUSTMENT', date: today(), accountId: a.cashId, direction: 'INCREASE', amount: '500', reason: 'Free money please' })).status).toBe(403);
    expect((await accountant.post('/api/accounts', { kind: 'CASH', name: 'Shadow Till' })).status).toBe(403);
    expect((await accountant.post('/api/categories', { name: 'Hidden', type: 'EXPENSE', plGroup: 'OTHER_EXPENSE' })).status).toBe(403);
  });

  it('admin manages the company and non-admin users', async () => {
    expect((await adminA.patch('/api/company', { city: 'Chennai' })).status).toBe(200);
    expect((await adminA.get('/api/users')).status).toBe(200);
    expect((await adminA.get('/api/audit-logs')).status).toBe(200);
    expect((await adminA.patch(`/api/users/${accountantId}`, { fullName: 'Renamed Accountant' })).status).toBe(200);
  });
});

describe('privilege escalation is blocked', () => {
  it('nobody can change their own role or status', async () => {
    const self = await adminA.patch(`/api/users/${adminAId}`, { role: 'SUPER_ADMIN' });
    expect(self.status).toBe(403);
    expect((await adminA.patch(`/api/users/${adminAId}/status`, { status: 'INACTIVE' })).status).toBe(403);
    const superSelf = await a.admin.patch(`/api/users/${a.admin.user!.id}`, { role: 'VIEWER' });
    expect(superSelf.status).toBe(403);
  });

  it('an admin cannot create, promote, edit or deactivate administrators', async () => {
    expect((await adminA.post('/api/users', { fullName: 'Second Admin', email: 'admin2@example.com', role: 'ADMIN' })).status).toBe(403);
    expect((await adminA.post('/api/users', { fullName: 'Root User', email: 'root@example.com', role: 'SUPER_ADMIN' })).status).toBe(403);
    expect((await adminA.patch(`/api/users/${accountantId}`, { role: 'ADMIN' })).status).toBe(403);
    expect((await adminA.patch(`/api/users/${a.admin.user!.id}`, { fullName: 'Hacked' })).status).toBe(403);
    expect((await adminA.patch(`/api/users/${a.admin.user!.id}/status`, { status: 'INACTIVE' })).status).toBe(403);
    expect((await adminA.post(`/api/users/${a.admin.user!.id}/reset-password`)).status).toBe(403);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: accountantId }, include: { role: true } });
    expect(row.role.name).toBe('ACCOUNTANT');
  });

  it('a super admin can authorise administrators, but the last super admin is protected', async () => {
    const promoted = await a.admin.patch(`/api/users/${accountantId}`, { role: 'ADMIN' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.data.role).toBe('ADMIN');
    expect((await a.admin.patch(`/api/users/${accountantId}`, { role: 'ACCOUNTANT' })).status).toBe(200);
    // Role change revoked the user's sessions; they sign in again with the new role.
    expect((await accountant.get('/api/transactions')).status).toBe(401);
    await accountant.login((await prisma.user.findUniqueOrThrow({ where: { id: accountantId } })).email);
    expect((await accountant.get('/api/transactions')).status).toBe(200);
  });

  it('mass-assignment of privileged fields is ignored', async () => {
    const r = await adminA.patch(`/api/users/${accountantId}`, { fullName: 'Still Accountant', companyId: b.companyId, roleId: 'x', passwordHash: 'x', status: 'INACTIVE' });
    expect(r.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: accountantId }, include: { role: true } });
    expect(row.companyId).toBe(a.companyId);
    expect(row.role.name).toBe('ACCOUNTANT');
    expect(row.status).toBe('ACTIVE');
  });

  it('user management responses never expose credentials', async () => {
    const r = await a.admin.get('/api/users');
    expect(JSON.stringify(r.body)).not.toMatch(/passwordHash|argon2|tokenHash/);
  });
});

describe('company data isolation', () => {
  let txnA: string, invA: string, custA: string, payA: string;

  beforeAll(async () => {
    txnA = (await a.admin.post('/api/income', income(a, '7777.00'), idem())).body.data.id;
    custA = (await a.admin.post('/api/customers', { name: 'Alpha Customer' })).body.data.id;
    const inv = await a.admin.post('/api/invoices', { customerId: custA, issueDate: today(), issue: true, items: [{ description: 'Secret work', quantity: '1', unitPrice: '5000', categoryId: a.cat('Service Revenue') }] });
    invA = inv.body.data.id;
    const pay = await a.admin.post(`/api/invoices/${invA}/payments`, { date: today(), amount: '1000', paymentMethod: 'UPI', accountId: a.bankId, gatewayPaymentId: 'UPI-ALPHA-1' });
    payA = pay.body.data.id;
  });

  it('lists only the caller’s own records', async () => {
    const forB = await b.admin.get('/api/transactions');
    expect(forB.status).toBe(200);
    expect(forB.body.data).toHaveLength(0);
    expect((await b.admin.get('/api/customers')).body.data).toHaveLength(0);
    expect((await b.admin.get('/api/invoices')).body.data).toHaveLength(0);
    expect((await b.admin.get('/api/payments')).body.data).toHaveLength(0);
    expect((await b.admin.get('/api/users')).body.data.every((u: { email: string }) => u.email === b.email)).toBe(true);
    const sumB = (await b.admin.get('/api/dashboard/summary')).body.data;
    expect(sumB.totalIncome).toBe('0.00');
    expect(sumB.receivables).toBe('0.00');
    const logsB = await b.admin.get('/api/audit-logs?pageSize=200');
    expect(JSON.stringify(logsB.body)).not.toContain('Alpha');
  });

  it('cannot read another company’s records by id', async () => {
    for (const url of [`/api/transactions/${txnA}`, `/api/invoices/${invA}`, `/api/invoices/${invA}/pdf`, `/api/customers/${custA}`, `/api/accounts/${a.cashId}/transactions`, `/api/accounts/${a.bankId}/reconciliation`, `/api/users/${adminAId}/activity`]) {
      const r = await b.admin.get(url);
      expect(r.status, url).toBe(404);
    }
  });

  it('cannot modify another company’s records', async () => {
    expect((await b.admin.post(`/api/transactions/${txnA}/reverse`, { reason: 'Cross-tenant attack' })).status).toBe(404);
    expect((await b.admin.patch(`/api/transactions/${txnA}`, { description: 'defaced' })).status).toBe(404);
    expect((await b.admin.post(`/api/invoices/${invA}/cancel`, { reason: 'Cross-tenant attack' })).status).toBe(404);
    expect((await b.admin.post(`/api/invoices/${invA}/payments`, { date: today(), amount: '1', paymentMethod: 'CASH', accountId: b.cashId })).status).toBe(404);
    expect((await b.admin.post(`/api/payments/${payA}/refund`, { amount: '1', date: today(), reason: 'Cross-tenant attack' })).status).toBe(404);
    expect((await b.admin.patch(`/api/customers/${custA}`, { name: 'Stolen' })).status).toBe(404);
    expect((await b.admin.patch(`/api/users/${adminAId}`, { fullName: 'Stolen' })).status).toBe(404);
    expect((await b.admin.patch(`/api/users/${adminAId}/status`, { status: 'INACTIVE' })).status).toBe(404);
    expect((await b.admin.patch(`/api/accounts/${a.cashId}`, { name: 'Stolen' })).status).toBe(404);
  });

  it('cannot reference another company’s accounts, categories or parties in its own entries', async () => {
    const foreignAccount = await b.admin.post('/api/income', { ...income(b), accountId: a.cashId });
    expect(foreignAccount.status).toBe(400);
    const foreignCategory = await b.admin.post('/api/income', { ...income(b), categoryId: a.cat('Product Sales') });
    expect(foreignCategory.status).toBe(400);
    const foreignCustomer = await b.admin.post('/api/income', { ...income(b), customerId: custA });
    expect(foreignCustomer.status).toBe(400);
    const transfer = await b.admin.post('/api/transactions', { type: 'TRANSFER', date: today(), fromAccountId: a.bankId, toAccountId: b.bankId, amount: '100' });
    expect(transfer.status).toBe(400);
    const invoice = await b.admin.post('/api/invoices', { customerId: custA, issueDate: today(), items: [{ description: 'x', quantity: '1', unitPrice: '1', categoryId: b.cat('Service Revenue') }] });
    expect(invoice.status).toBe(400);
    // Nothing leaked into either ledger.
    expect(await prisma.journalEntryLine.count({ where: { companyId: b.companyId, accountId: { in: [a.cashId, a.bankId] } } })).toBe(0);
  });

  it('an existing user of one company cannot be claimed by another', async () => {
    const r = await b.admin.post('/api/users', { fullName: 'Poached', email: a.email, role: 'VIEWER' });
    expect(r.status).toBe(409);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: a.email } })).companyId).toBe(a.companyId);
  });

  it('each company’s totals are unaffected by the other', async () => {
    await b.admin.post('/api/income', income(b, '50.00'), idem());
    const sa = (await a.admin.get('/api/dashboard/summary')).body.data;
    const sb = (await b.admin.get('/api/dashboard/summary')).body.data;
    expect(sb.totalIncome).toBe('50.00');
    expect(Number(sa.totalIncome)).toBeGreaterThan(7777);
    expect(sb.cashBalance).toBe('50.00');
  });
});
