import { beforeAll, describe, expect, it } from 'vitest';
import { addUser, bootstrapCompany, Client, daysAgo, idem, prisma, resetDb, today } from './helpers';

type Ctx = Awaited<ReturnType<typeof bootstrapCompany>>;
let c: Ctx;
let admin: Client;

const balances = async (who: Client = admin) => {
  const list = (await who.get('/api/accounts')).body.data as Array<{ id: string; balance: string }>;
  return { cash: list.find((x) => x.id === c.cashId)!.balance, bank: list.find((x) => x.id === c.bankId)!.balance };
};
const income = (over: Record<string, unknown> = {}) => ({ date: today(), categoryId: c.cat('Product Sales'), amount: '1000.00', paymentMethod: 'CASH', accountId: c.cashId, description: 'Sale', ...over });
const expense = (over: Record<string, unknown> = {}) => ({ date: today(), categoryId: c.cat('Rent'), amount: '300.00', paymentMethod: 'CASH', accountId: c.cashId, description: 'Rent', ...over });

/** The fundamental invariant: for the whole company, total debits equal total credits, and every entry balances. */
async function assertLedgerBalanced(companyId: string) {
  const rows = await prisma.$queryRaw<{ id: string; d: string; cr: string }[]>`
    SELECT "journalEntryId" AS id, SUM("debit")::text AS d, SUM("credit")::text AS cr FROM "JournalEntryLine" WHERE "companyId" = ${companyId} GROUP BY 1`;
  for (const r of rows) expect(r.d, `entry ${r.id}`).toBe(r.cr);
  // The cash/bank book must agree with the ledger for every money account.
  const diff = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*) AS n FROM (
      SELECT a."id",
        (SELECT COALESCE(SUM(l."debit" - l."credit"), 0) FROM "JournalEntryLine" l WHERE l."accountId" = a."id") AS ledger,
        (SELECT COALESCE(SUM(CASE WHEN x."direction" = 'IN' THEN x."amount" ELSE -x."amount" END), 0) FROM "AccountTransaction" x WHERE x."accountId" = a."id") AS book
      FROM "Account" a WHERE a."companyId" = ${companyId} AND a."subtype" IN ('CASH', 'BANK')
    ) t WHERE t.ledger <> t.book`;
  expect(Number(diff[0].n)).toBe(0);
}

beforeAll(async () => {
  await resetDb();
  c = await bootstrapCompany('Ledger Co');
  admin = c.admin;
});

describe('transaction creation', () => {
  it('records income and updates the cash balance', async () => {
    const res = await admin.post('/api/income', income({ taxAmount: '180.00', reference: 'RCPT-1' }), idem());
    expect(res.status).toBe(201);
    const t = res.body.data;
    expect(t.number).toMatch(/^TXN-\d{6}$/);
    expect(t.type).toBe('INCOME');
    expect(t.status).toBe('POSTED');
    expect(t.companyId).toBe(c.companyId);
    expect(t.currency).toBe('INR');
    expect(t.totalAmount).toBe('1180');
    expect((await balances()).cash).toBe('1180.00');

    const detail = (await admin.get(`/api/transactions/${t.id}`)).body.data;
    expect(detail.createdBy).toBeTruthy();
    const lines = detail.journal[0].lines as Array<{ account: string; debit: string; credit: string }>;
    expect(lines.find((l) => l.account.includes('Cash in Hand'))!.debit).toBe('1180.00');
    expect(lines.find((l) => l.account.includes('Revenue'))!.credit).toBe('1000.00');
    expect(lines.find((l) => l.account.includes('Output Tax'))!.credit).toBe('180.00');
    await assertLedgerBalanced(c.companyId);
  });

  it('records an expense and reduces the balance', async () => {
    const res = await admin.post('/api/expenses', expense(), idem());
    expect(res.status).toBe(201);
    expect((await balances()).cash).toBe('880.00');
  });

  it('rejects zero, negative, over-precise and absurd amounts', async () => {
    for (const amount of ['0', '0.00', '-100', '10.999', 'abc', '', '1e9', '99999999999999.99', null]) {
      const r = await admin.post('/api/income', income({ amount }));
      expect(r.status, `amount=${amount}`).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
      expect(r.body.error.details.fields.amount).toBeTruthy();
    }
    expect((await admin.post('/api/income', income({ taxAmount: '-1' }))).status).toBe(400);
    expect((await balances()).cash).toBe('880.00');
  });

  it('handles very large amounts exactly', async () => {
    const big = '9999999999999.99';
    const r = await admin.post('/api/income', income({ amount: big, paymentMethod: 'BANK_TRANSFER', accountId: c.bankId }), idem());
    expect(r.status).toBe(201);
    expect((await balances()).bank).toBe(big);
    const rev = await admin.post(`/api/transactions/${r.body.data.id}/reverse`, { reason: 'Test entry for large amounts' });
    expect(rev.status).toBe(201);
    expect((await balances()).bank).toBe('0.00');
  });

  it('rejects invalid and future dates', async () => {
    for (const date of ['2026-02-30', '31-01-2026', 'yesterday', '', '2026-13-01']) {
      const r = await admin.post('/api/income', income({ date }));
      expect(r.status, `date=${date}`).toBe(400);
    }
    const future = await admin.post('/api/income', income({ date: '2999-01-01' }));
    expect(future.status).toBe(400);
    expect(future.body.error.details.fields.date).toBeTruthy();
  });

  it('rejects unknown categories, wrong category type and method/account mismatches', async () => {
    expect((await admin.post('/api/income', income({ categoryId: 'nope' }))).status).toBe(400);
    expect((await admin.post('/api/income', income({ categoryId: c.cat('Rent') }))).status).toBe(400); // expense category on income
    expect((await admin.post('/api/income', income({ paymentMethod: 'UPI' }))).status).toBe(422); // UPI into a cash till
    expect((await admin.post('/api/income', income({ paymentMethod: 'CASH', accountId: c.bankId }))).status).toBe(422);
    expect((await admin.post('/api/income', income({ paymentMethod: 'CREDIT' }))).status).toBe(400);
    expect((await admin.post('/api/transactions', { ...income(), type: 'BOGUS' })).status).toBe(400);
  });

  it('never lets a cash account go below zero', async () => {
    const r = await admin.post('/api/expenses', expense({ amount: '100000.00' }));
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('INSUFFICIENT_CASH');
    expect((await balances()).cash).toBe('880.00');
    // The failed attempt left nothing behind (the whole DB transaction rolled back).
    expect(await prisma.transaction.count({ where: { companyId: c.companyId, totalAmount: '100000.00' } })).toBe(0);
  });
});

describe('duplicate request protection', () => {
  it('replays the original response for a repeated Idempotency-Key', async () => {
    const key = idem();
    const before = (await balances()).cash;
    const first = await admin.post('/api/income', income({ amount: '250.00' }), key);
    const second = await admin.post('/api/income', income({ amount: '250.00' }), key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(Number((await balances()).cash) - Number(before)).toBe(250);
  });

  it('posts only once when identical requests race', async () => {
    const key = idem();
    const before = Number((await balances()).cash);
    const results = await Promise.all(Array.from({ length: 6 }, () => admin.post('/api/income', income({ amount: '40.00' }), key)));
    const created = results.filter((r) => r.status === 201 && !r.headers['idempotent-replay']);
    expect(created.length).toBe(1);
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(Number((await balances()).cash) - before).toBe(40);
  });

  it('a failed request releases its key so the corrected retry succeeds', async () => {
    const key = idem();
    expect((await admin.post('/api/income', income({ amount: '-1' }), key)).status).toBe(400);
    expect((await admin.post('/api/income', income({ amount: '10.00' }), key)).status).toBe(201);
  });
});

describe('concurrent transactions', () => {
  it('keeps balances exact under parallel postings', async () => {
    const before = Number((await balances()).cash);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => admin.post('/api/income', income({ amount: `${i + 1}.25` }), idem())));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const numbers = results.map((r) => r.body.data.number);
    expect(new Set(numbers).size).toBe(12); // unique transaction ids
    expect(Number((await balances()).cash) - before).toBeCloseTo(78 + 12 * 0.25, 2);
    await assertLedgerBalanced(c.companyId);
  });

  it('cannot overdraw cash through a race', async () => {
    const { cash } = await balances();
    const each = (Number(cash) * 0.6).toFixed(2); // two of these exceed the balance
    const results = await Promise.all([admin.post('/api/expenses', expense({ amount: each }), idem()), admin.post('/api/expenses', expense({ amount: each }), idem())]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 422]);
    expect(Number((await balances()).cash)).toBeGreaterThanOrEqual(0);
  });
});

describe('bank transfers', () => {
  it('moves money between accounts without touching profit', async () => {
    await admin.post('/api/income', income({ amount: '5000.00' }), idem());
    const before = await balances();
    const pl = (await admin.get('/api/dashboard/summary')).body.data;
    const r = await admin.post('/api/transactions', { type: 'TRANSFER', date: today(), fromAccountId: c.cashId, toAccountId: c.bankId, amount: '2000.00', description: 'Cash deposit' }, idem());
    expect(r.status).toBe(201);
    const after = await balances();
    expect(Number(after.cash)).toBeCloseTo(Number(before.cash) - 2000, 2);
    expect(Number(after.bank)).toBeCloseTo(Number(before.bank) + 2000, 2);
    expect(Number(after.cash) + Number(after.bank)).toBeCloseTo(Number(before.cash) + Number(before.bank), 2);
    const pl2 = (await admin.get('/api/dashboard/summary')).body.data;
    expect(pl2.totalIncome).toBe(pl.totalIncome);
    expect(pl2.totalExpenses).toBe(pl.totalExpenses);
    expect(pl2.netProfit).toBe(pl.netProfit);
  });

  it('rejects same-account and over-balance transfers', async () => {
    expect((await admin.post('/api/transactions', { type: 'TRANSFER', date: today(), fromAccountId: c.cashId, toAccountId: c.cashId, amount: '10' })).status).toBe(400);
    const r = await admin.post('/api/transactions', { type: 'TRANSFER', date: today(), fromAccountId: c.cashId, toAccountId: c.bankId, amount: '99999999' });
    expect(r.status).toBe(422);
  });
});

describe('cash balance formula', () => {
  it('closing = opening + inflows − outflows, and matches the ledger', async () => {
    const book = (await admin.get(`/api/accounts/${c.cashId}/transactions?from=${today()}&to=${today()}`)).body.meta.summary;
    expect(Number(book.closing)).toBeCloseTo(Number(book.opening) + Number(book.inflow) - Number(book.outflow), 2);
    expect(book.closing).toBe(book.bookBalance);
    expect(book.bookBalance).toBe((await balances()).cash);
  });

  it('opening balances are posted as real ledger entries', async () => {
    const r = await admin.post('/api/accounts', { kind: 'CASH', name: 'Petty Cash', openingBalance: '1500.00', openingDate: daysAgo(10) }, idem());
    expect(r.status).toBe(201);
    const acc = ((await admin.get('/api/accounts')).body.data as Array<{ id: string; balance: string }>).find((x) => x.id === r.body.data.id)!;
    expect(acc.balance).toBe('1500.00');
    const book = (await admin.get(`/api/accounts/${acc.id}/transactions?from=${today()}&to=${today()}`)).body.meta.summary;
    expect(book.opening).toBe('1500.00'); // dated 10 days ago, so it is today's opening balance
    await assertLedgerBalanced(c.companyId);
  });

  it('adjustments need a reason, are admin-only and are audited', async () => {
    const before = Number((await balances()).cash);
    expect((await admin.post('/api/transactions', { type: 'ADJUSTMENT', date: today(), accountId: c.cashId, direction: 'DECREASE', amount: '15.00' })).status).toBe(400);
    expect((await admin.post('/api/transactions', { type: 'ADJUSTMENT', date: today(), accountId: c.cashId, direction: 'DECREASE', amount: '15.00', reason: 'x' })).status).toBe(400);
    const r = await admin.post('/api/transactions', { type: 'ADJUSTMENT', date: today(), accountId: c.cashId, direction: 'DECREASE', amount: '15.00', reason: 'Till short after daily count' }, idem());
    expect(r.status).toBe(201);
    expect(Number((await balances()).cash)).toBeCloseTo(before - 15, 2);
    const log = await prisma.auditLog.findFirst({ where: { companyId: c.companyId, action: 'adjustment.create', entityId: r.body.data.id } });
    expect(log?.summary).toContain('Till short after daily count');
  });

  it('there is no API to overwrite a balance directly', async () => {
    const r = await admin.patch(`/api/accounts/${c.cashId}`, { balance: '1000000', openingBalance: '1000000', name: 'Cash in Hand' });
    expect(r.status).toBe(200);
    expect(Number((await balances()).cash)).toBeLessThan(1000000);
  });
});

describe('transaction reversal', () => {
  it('reverses with a mirror entry, links both records and restores the balance', async () => {
    const before = await balances();
    const t = (await admin.post('/api/income', income({ amount: '640.00', taxAmount: '32.00' }), idem())).body.data;
    expect(Number((await balances()).cash)).toBeCloseTo(Number(before.cash) + 672, 2);

    expect((await admin.post(`/api/transactions/${t.id}/reverse`, {})).status).toBe(400); // reason required
    const rev = await admin.post(`/api/transactions/${t.id}/reverse`, { reason: 'Entered against the wrong customer' }, idem());
    expect(rev.status).toBe(201);
    expect(rev.body.data.isReversal).toBe(true);
    expect(rev.body.data.reversalOfId).toBe(t.id);
    expect((await balances()).cash).toBe(before.cash);

    const original = (await admin.get(`/api/transactions/${t.id}`)).body.data;
    expect(original.status).toBe('REVERSED');
    expect(original.reversedBy.number).toBe(rev.body.data.number);
    // The original record and its journal still exist: nothing was deleted.
    expect(original.journal).toHaveLength(1);
    expect(original.history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['transaction.create', 'transaction.reverse']));
    await assertLedgerBalanced(c.companyId);
  });

  it('cannot reverse twice, reverse a reversal, or delete a transaction', async () => {
    const t = (await admin.post('/api/income', income({ amount: '12.00' }), idem())).body.data;
    const rev = await admin.post(`/api/transactions/${t.id}/reverse`, { reason: 'Duplicate of an earlier entry' });
    const again = await admin.post(`/api/transactions/${t.id}/reverse`, { reason: 'Duplicate of an earlier entry' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('ALREADY_REVERSED');
    expect((await admin.post(`/api/transactions/${rev.body.data.id}/reverse`, { reason: 'Undo the undo please' })).status).toBe(422);
    const del = await (await import('supertest')).default((await import('./helpers')).app).delete(`/api/transactions/${t.id}`).set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf);
    expect(del.status).toBe(404); // no delete endpoint exists
    expect(await prisma.transaction.count({ where: { id: t.id } })).toBe(1);
  });

  it('concurrent reversals of one transaction post exactly one reversal', async () => {
    const t = (await admin.post('/api/income', income({ amount: '77.00' }), idem())).body.data;
    const before = Number((await balances()).cash);
    const results = await Promise.all(Array.from({ length: 4 }, () => admin.post(`/api/transactions/${t.id}/reverse`, { reason: 'Racing reversal requests' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(Number((await balances()).cash)).toBeCloseTo(before - 77, 2);
  });

  it('posted transactions cannot be financially edited', async () => {
    const t = (await admin.post('/api/income', income({ amount: '90.00' }), idem())).body.data;
    const edit = await admin.patch(`/api/transactions/${t.id}`, { amount: '9000.00' });
    expect(edit.status).toBe(422);
    expect(edit.body.error.code).toBe('FINALIZED');
    const meta = await admin.patch(`/api/transactions/${t.id}`, { description: 'Corrected narration' });
    expect(meta.status).toBe(200);
    const after = (await admin.get(`/api/transactions/${t.id}`)).body.data;
    expect(after.totalAmount).toBe('90.00');
    expect(after.description).toBe('Corrected narration');
  });

  it('the database itself refuses to alter posted ledger lines or audit records', async () => {
    const line = await prisma.journalEntryLine.findFirstOrThrow({ where: { companyId: c.companyId } });
    await expect(prisma.journalEntryLine.update({ where: { id: line.id }, data: { debit: '1.00' } })).rejects.toThrow();
    await expect(prisma.journalEntryLine.delete({ where: { id: line.id } })).rejects.toThrow();
    const log = await prisma.auditLog.findFirstOrThrow({ where: { companyId: c.companyId } });
    await expect(prisma.auditLog.update({ where: { id: log.id }, data: { summary: 'tampered' } })).rejects.toThrow();
    await expect(prisma.auditLog.delete({ where: { id: log.id } })).rejects.toThrow();
  });

  it('the database rejects an unbalanced journal entry at commit', async () => {
    const entry = await prisma.journalEntry.findFirstOrThrow({ where: { companyId: c.companyId } });
    await expect(
      prisma.journalEntryLine.create({ data: { journalEntryId: entry.id, companyId: c.companyId, accountId: c.cashId, debit: '5.00', credit: '0' } }),
    ).rejects.toThrow(/not balanced/);
  });
});

describe('expense approval workflow', () => {
  let accountant: Client;
  let other: Awaited<ReturnType<typeof bootstrapCompany>>;

  beforeAll(async () => {
    other = await bootstrapCompany('Approval Co');
    await other.admin.post('/api/income', { date: today(), categoryId: other.cat('Product Sales'), amount: '10000', paymentMethod: 'CASH', accountId: other.cashId }, idem());
    expect((await other.admin.patch('/api/settings', { expenseApprovalRequired: true })).status).toBe(200);
    accountant = (await addUser(other.admin, 'ACCOUNTANT')).client;
  });
  const exp = (over = {}) => ({ date: today(), categoryId: other.cat('Utilities'), amount: '400.00', paymentMethod: 'CASH', accountId: other.cashId, description: 'Electricity', ...over });
  const cash = async () => ((await other.admin.get('/api/accounts')).body.data as Array<{ id: string; balance: string }>).find((x) => x.id === other.cashId)!.balance;

  it('a pending expense does not touch the ledger until approved', async () => {
    const r = await accountant.post('/api/expenses', exp(), idem());
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('PENDING_APPROVAL');
    expect(await cash()).toBe('10000.00');
    expect((await other.admin.get('/api/dashboard/summary')).body.data.totalExpenses).toBe('0.00');

    expect((await accountant.post(`/api/transactions/${r.body.data.id}/approve`)).status).toBe(403); // no approval right
    const ok = await other.admin.post(`/api/transactions/${r.body.data.id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('POSTED');
    expect(await cash()).toBe('9600.00');
    expect((await other.admin.post(`/api/transactions/${r.body.data.id}/approve`)).status).toBe(422); // not twice
    expect(await cash()).toBe('9600.00');
  });

  it('blocks self-approval unless company policy allows it', async () => {
    const mine = await other.admin.post('/api/expenses', exp({ amount: '50.00' }), idem());
    const self = await other.admin.post(`/api/transactions/${mine.body.data.id}/approve`);
    expect(self.status).toBe(403);
    await other.admin.patch('/api/settings', { allowSelfApproval: true });
    expect((await other.admin.post(`/api/transactions/${mine.body.data.id}/approve`)).status).toBe(200);
    await other.admin.patch('/api/settings', { allowSelfApproval: false });
  });

  it('a rejected expense never posts', async () => {
    const before = await cash();
    const r = await accountant.post('/api/expenses', exp({ amount: '999.00' }), idem());
    expect((await other.admin.post(`/api/transactions/${r.body.data.id}/reject`, {})).status).toBe(400);
    const rej = await other.admin.post(`/api/transactions/${r.body.data.id}/reject`, { reason: 'No supporting receipt attached' });
    expect(rej.status).toBe(200);
    expect(rej.body.data.status).toBe('REJECTED');
    expect(await cash()).toBe(before);
    expect((await other.admin.post(`/api/transactions/${r.body.data.id}/approve`)).status).toBe(422);
  });

  it('settings changes are written to the audit log', async () => {
    const log = await prisma.auditLog.findFirst({ where: { companyId: other.companyId, action: 'settings.update' }, orderBy: { createdAt: 'asc' } });
    expect(log?.summary).toContain('expenseApprovalRequired');
  });
});
