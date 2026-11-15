import { beforeAll, describe, expect, it } from 'vitest';
import { addUser, bootstrapCompany, Client, daysAgo, idem, prisma, resetDb, today } from './helpers';

type Ctx = Awaited<ReturnType<typeof bootstrapCompany>>;
let c: Ctx;
let admin: Client;
const num = (s: unknown) => Number(s);
const report = async (key: string, qs = '') => (await admin.get(`/api/reports/${key}?${qs}`)).body.data;
const binary = (r: import('supertest').Test) => r.buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (d: Buffer) => chunks.push(d)); res.on('end', () => cb(null, Buffer.concat(chunks))); });

/**
 * Fixture (all through the public API):
 *   day-40  income  Product Sales   10,000 cash                      (outside the 30-day window)
 *   day-10  income  Service Revenue  6,000 + 1,080 tax  UPI → bank
 *   day-10  expense Cost of Goods    2,500 cash
 *   day-5   expense Rent             1,200 bank transfer
 *   day-5   transfer cash → bank     3,000
 *   day-3   invoice Consulting       4,000 + 720 tax (issued), 1,180 received by net banking on day-2
 *   day-2   expense Marketing          800 on credit (supplier bill), unpaid
 *   day-1   income  Other Income       500 cash, then reversed today
 */
beforeAll(async () => {
  await resetDb();
  c = await bootstrapCompany('Report Co');
  admin = c.admin;
  const ok = (r: { status: number; body: unknown }) => { if (r.status !== 201) throw new Error(JSON.stringify(r.body)); return r; };
  ok(await admin.post('/api/income', { date: daysAgo(40), categoryId: c.cat('Product Sales'), amount: '10000', paymentMethod: 'CASH', accountId: c.cashId }, idem()));
  ok(await admin.post('/api/income', { date: daysAgo(10), categoryId: c.cat('Service Revenue'), amount: '6000', taxAmount: '1080', paymentMethod: 'UPI', accountId: c.bankId }, idem()));
  ok(await admin.post('/api/expenses', { date: daysAgo(10), categoryId: c.cat('Cost of Goods Sold'), amount: '2500', paymentMethod: 'CASH', accountId: c.cashId }, idem()));
  ok(await admin.post('/api/expenses', { date: daysAgo(5), categoryId: c.cat('Rent'), amount: '1200', paymentMethod: 'BANK_TRANSFER', accountId: c.bankId }, idem()));
  ok(await admin.post('/api/transactions', { type: 'TRANSFER', date: daysAgo(5), fromAccountId: c.cashId, toAccountId: c.bankId, amount: '3000' }, idem()));
  const cust = ok(await admin.post('/api/customers', { name: 'Initech' })).body as { data: { id: string } };
  const inv = ok(await admin.post('/api/invoices', { customerId: cust.data.id, issueDate: daysAgo(3), issue: true, items: [{ description: 'Advisory', quantity: '1', unitPrice: '4000', taxRate: '18', categoryId: c.cat('Consulting Income') }] }, idem())).body as { data: { id: string } };
  ok(await admin.post(`/api/invoices/${inv.data.id}/payments`, { date: daysAgo(2), amount: '1180', paymentMethod: 'NET_BANKING', accountId: c.bankId }, idem()));
  const sup = ok(await admin.post('/api/suppliers', { name: 'AdWorks' })).body as { data: { id: string } };
  ok(await admin.post('/api/expenses', { date: daysAgo(2), categoryId: c.cat('Marketing and Advertising'), supplierId: sup.data.id, amount: '800', paymentMethod: 'CREDIT' }, idem()));
  const temp = ok(await admin.post('/api/income', { date: daysAgo(1), categoryId: c.cat('Other Income'), amount: '500', paymentMethod: 'CASH', accountId: c.cashId }, idem())).body as { data: { id: string } };
  ok(await admin.post(`/api/transactions/${temp.data.id}/reverse`, { reason: 'Entered by mistake yesterday' }));
});

const last30 = () => `from=${daysAgo(29)}&to=${today()}`;
const all = () => `from=${daysAgo(60)}&to=${today()}`;

describe('profit and loss', () => {
  it('nets a reversal against the original and excludes tax and transfers', async () => {
    const s = (await admin.get(`/api/dashboard/summary?${last30()}`)).body.data;
    // Income in window: 6000 (service) + 4000 (invoice, net of tax) + 500 − 500 (reversed) = 10000
    expect(num(s.totalIncome)).toBe(10000);
    // Expenses in window: 2500 (COGS) + 1200 (rent) + 800 (marketing bill) = 4500
    expect(s.totalExpenses).toBe('4500.00');
    expect(s.grossProfit).toBe('7500.00'); // 10000 − 2500 direct costs
    expect(s.netProfit).toBe('5500.00');
  });

  it('profit is not the cash balance', async () => {
    const s = (await admin.get(`/api/dashboard/summary?${last30()}`)).body.data;
    // Cash: 10000 − 2500 − 3000 = 4500. Bank: 7080 − 1200 + 3000 + 1180 = 10060.
    expect(s.cashBalance).toBe('4500.00');
    expect(s.bankBalance).toBe('10060.00');
    expect(num(s.cashBalance) + num(s.bankBalance)).not.toBe(num(s.netProfit));
    expect(s.receivables).toBe('3540.00'); // 4720 − 1180
    expect(s.payables).toBe('800.00');
    expect(s.onlineReceipts).toBe('8260.00'); // 7080 UPI + 1180 net banking (the internal transfer is excluded)
  });

  it('statement foots: gross = revenue − direct costs, net = income − expenses', async () => {
    const r = await report('profit-loss', last30());
    const row = (label: string) => num(r.rows.find((x: { label: string }) => x.label.trim() === label).amount);
    expect(row('Total Revenue')).toBe(10000);
    expect(row('Sales Revenue')).toBe(10000);
    expect(row('Other Operating Income')).toBe(0);
    expect(row('Total Direct Costs')).toBe(2500);
    expect(row('Gross Profit')).toBe(row('Total Revenue') - row('Total Direct Costs'));
    expect(row('Rent and Utilities')).toBe(1200);
    expect(row('Marketing Expenses')).toBe(800);
    expect(row('Net Profit')).toBe(row('Gross Profit') - row('Total Operating Expenses'));
    expect(r.meta.basis).toMatch(/Accrual/);
    expect(r.meta.companyName).toBe('Report Co');
    expect(r.meta.currency).toBe('INR');
    expect(r.meta.generatedAt).toBeTruthy();
  });

  it('compares with the previous period', async () => {
    const r = await report('profit-loss', `from=${daysAgo(29)}&to=${today()}&compare=1`);
    const total = r.rows.find((x: { label: string }) => x.label.trim() === 'Total Revenue');
    expect(num(total.previous)).toBe(10000); // the day-40 sale falls in the previous 30-day window
    expect(num(total.change)).toBe(0);
  });
});

describe('date range filtering', () => {
  it('includes boundary days and excludes everything outside', async () => {
    const d10 = daysAgo(10);
    const one = (await admin.get(`/api/dashboard/summary?from=${d10}&to=${d10}`)).body.data;
    expect(one.totalIncome).toBe('6000.00');
    expect(one.totalExpenses).toBe('2500.00');
    const before = (await admin.get(`/api/dashboard/summary?from=${daysAgo(9)}&to=${daysAgo(6)}`)).body.data;
    expect(before.totalIncome).toBe('0.00');
    expect(before.totalExpenses).toBe('0.00');
    const everything = (await admin.get(`/api/dashboard/summary?${all()}`)).body.data;
    expect(everything.totalIncome).toBe('20000.00');
  });

  it('balances are as of the range end date', async () => {
    const s = (await admin.get(`/api/dashboard/summary?from=${daysAgo(60)}&to=${daysAgo(20)}`)).body.data;
    expect(s.cashBalance).toBe('10000.00');
    expect(s.bankBalance).toBe('0.00');
    expect(s.receivables).toBe('0.00');
  });

  it('transaction list filters by date, type, method, status and search', async () => {
    const list = async (qs: string) => (await admin.get(`/api/transactions?${qs}`)).body;
    expect((await list(`from=${daysAgo(10)}&to=${daysAgo(10)}`)).meta.total).toBe(2);
    expect((await list('type=TRANSFER')).data).toHaveLength(1);
    expect((await list('paymentMethod=UPI')).data.every((t: { paymentMethod: string }) => t.paymentMethod === 'UPI')).toBe(true);
    expect((await list('status=REVERSED')).data).toHaveLength(1);
    expect((await list(`accountId=${c.bankId}&type=EXPENSE`)).data).toHaveLength(1);
    expect((await list(`categoryId=${c.cat('Rent')}`)).data).toHaveLength(1);
    expect((await list('q=adworks')).data).toHaveLength(1);
    const page = await list('pageSize=3&page=2&sort=amount&order=desc');
    expect(page.data.length).toBeLessThanOrEqual(3);
    expect(page.meta.page).toBe(2);
    expect((await admin.get('/api/transactions?from=2026-02-31')).status).toBe(400);
    expect((await admin.get('/api/transactions?pageSize=100000')).status).toBe(400);
    expect((await admin.get(`/api/dashboard/summary?from=${today()}&to=${daysAgo(5)}`)).status).toBe(400);
  });
});

describe('report totals reconcile with the ledger', () => {
  it('daily report: every row and the totals tie out', async () => {
    const r = await report('daily', last30());
    expect(r.rows).toHaveLength(30);
    let running = num(r.rows[0].opening);
    for (const row of r.rows) {
      expect(num(row.opening)).toBeCloseTo(running, 2);
      expect(num(row.net)).toBeCloseTo(num(row.cashIn) - num(row.cashOut) + num(row.bankIn) - num(row.bankOut), 2);
      expect(num(row.closing)).toBeCloseTo(num(row.opening) + num(row.net), 2);
      expect(num(row.profit)).toBeCloseTo(num(row.income) - num(row.expenses), 2);
      running = num(row.closing);
    }
    const sum = (k: string) => r.rows.reduce((a: number, x: Record<string, string>) => a + num(x[k]), 0);
    for (const k of ['income', 'expenses', 'cashIn', 'cashOut', 'bankIn', 'bankOut', 'onlineIn', 'onlineOut', 'net', 'profit']) expect(num(r.totals[k]), k).toBeCloseTo(sum(k), 2);

    const s = (await admin.get(`/api/dashboard/summary?${last30()}`)).body.data;
    expect(r.totals.income).toBe(s.totalIncome);
    expect(r.totals.expenses).toBe(s.totalExpenses);
    expect(r.totals.profit).toBe(s.netProfit);
    expect(num(r.totals.opening)).toBe(10000); // the day-40 cash sale
    expect(num(r.totals.closing)).toBeCloseTo(num(s.cashBalance) + num(s.bankBalance), 2);
  });

  it('monthly and annual reports agree with the daily figures', async () => {
    const m = await report('monthly', all());
    const a = await report('annual', all());
    const s = (await admin.get(`/api/dashboard/summary?from=${m.meta.from}&to=${m.meta.to}`)).body.data;
    expect(m.totals.income).toBe(s.totalIncome);
    expect(m.totals.expenses).toBe(s.totalExpenses);
    expect(m.totals.profit).toBe(s.netProfit);
    expect(a.totals.income).toBe(m.totals.income);
    expect(a.totals.closing).toBe(m.totals.closing);
    expect(num(m.totals.closing)).toBeCloseTo(num(s.cashBalance) + num(s.bankBalance), 2);
    expect(a.rows[0].period).toMatch(/^FY \d{4}/);
  });

  it('income and expense reports equal the P&L totals', async () => {
    const inc = await report('income', last30());
    const exp = await report('expenses', last30());
    expect(num(inc.totals.amount)).toBe(10000);
    expect(num(exp.totals.amount)).toBe(4500);
    expect(inc.rows.some((x: { amount: string }) => num(x.amount) < 0)).toBe(true); // the reversal is visible, not hidden
    const rentOnly = await report('expenses', `${last30()}&categoryId=${c.cat('Rent')}`);
    expect(num(rentOnly.totals.amount)).toBe(1200);
    expect(num((await report('income', `${last30()}&paymentMethod=UPI`)).totals.amount)).toBe(6000);
    expect((await report('expenses', `${last30()}&q=zzzz-no-match`)).rows).toHaveLength(0);
  });

  it('cash-flow statement and account reports equal the account balances', async () => {
    const cf = await report('cash-flow', last30());
    const row = (label: string) => num(cf.rows.find((x: { label: string }) => x.label.trim() === label).amount);
    expect(row('Opening cash and bank balance')).toBe(10000);
    expect(row('Net cash flow')).toBeCloseTo(row('Total inflows') - row('Total outflows'), 2);
    expect(row('Closing cash and bank balance')).toBe(14560);
    expect(row('Transfers in')).toBe(row('Transfers out'));

    const cash = await report('cash-accounts', last30());
    const bank = await report('bank-accounts', last30());
    expect(cash.totals.closing).toBe('4500.00');
    expect(bank.totals.closing).toBe('10060.00');
    for (const r of [...cash.rows, ...bank.rows]) expect(num(r.closing)).toBeCloseTo(num(r.opening) + num(r.inflow) - num(r.outflow), 2);

    const bankOnly = await report('cash-flow', `${last30()}&accountId=${c.bankId}`);
    expect(num(bankOnly.rows.at(-1).amount)).toBe(10060);
  });

  it('receivables, payables, party ledgers, online payments and tax summary', async () => {
    const rec = await report('receivables', last30());
    expect(rec.totals.balance).toBe('3540.00');
    expect(rec.rows[0].name).toBe('Initech');
    expect((await report('payables', last30())).totals.balance).toBe('800.00');
    const cust = await report('customer-transactions', last30());
    expect(num(cust.totals.charge) - num(cust.totals.settled)).toBe(3540);
    const sup = await report('supplier-transactions', last30());
    expect(num(sup.totals.charge) - num(sup.totals.settled)).toBe(800);
    const online = await report('online-payments', last30());
    expect(online.totals.amount).toBe('1180.00');
    const tax = await report('tax-summary', last30());
    expect(tax.totals.out).toBe('1800.00'); // 1080 + 720
    expect(tax.totals.net).toBe('1800.00');
  });

  it('charts use the same figures as the reports', async () => {
    const ie = (await admin.get(`/api/dashboard/income-expenses?${last30()}`)).body.data;
    expect(ie.granularity).toBe('day');
    expect(ie.series).toHaveLength(30);
    expect(ie.series.reduce((a: number, x: { income: string }) => a + num(x.income), 0)).toBeCloseTo(10000, 2);
    const pl = (await admin.get(`/api/dashboard/profit-loss?${last30()}`)).body.data;
    expect(num(pl.series.at(-1).cumulative)).toBe(5500);
    expect(pl.expenseCategories.map((x: { name: string }) => x.name)).toEqual(['Cost of Goods Sold', 'Rent', 'Marketing and Advertising']);
    const cf = (await admin.get(`/api/dashboard/cash-flow?${last30()}`)).body.data;
    expect(cf.series.reduce((a: number, x: { net: string }) => a + num(x.net), 0)).toBeCloseTo(4560, 2);
    expect(cf.paymentMethods.find((x: { method: string }) => x.method === 'UPI').received).toBe('7080.00');
    const monthly = (await admin.get(`/api/dashboard/income-expenses?from=${daysAgo(200)}&to=${today()}`)).body.data;
    expect(monthly.granularity).toBe('month');
  });
});

describe('cash-basis accounting method', () => {
  it('recognises invoice revenue and credit expenses only when paid', async () => {
    expect((await admin.patch('/api/settings', { accountingMethod: 'CASH' })).status).toBe(200);
    const s = (await admin.get(`/api/dashboard/summary?${last30()}`)).body.data;
    expect(s.accountingMethod).toBe('CASH');
    // Income: 6000 (paid at sale) + invoice receipt 1180 × 4000/4720 = 1000 ; the reversed 500 nets to zero.
    expect(s.totalIncome).toBe('7000.00');
    // Expenses: 2500 + 1200. The unpaid 800 bill is not yet an expense.
    expect(s.totalExpenses).toBe('3700.00');
    expect(s.netProfit).toBe('3300.00');
    // Balances do not depend on the accounting method.
    expect(s.cashBalance).toBe('4500.00');
    expect(s.receivables).toBe('3540.00');
    const r = await report('profit-loss', last30());
    expect(r.meta.basis).toMatch(/Cash basis/);
    const audit = await prisma.auditLog.findFirst({ where: { companyId: c.companyId, action: 'settings.update' } });
    expect(audit?.summary).toContain('accountingMethod');
    await admin.patch('/api/settings', { accountingMethod: 'ACCRUAL' });
    expect((await admin.get(`/api/dashboard/summary?${last30()}`)).body.data.totalIncome).toBe('10000.00');
  });
});

describe('exports', () => {
  it('CSV carries company, period, currency, timestamp and matching totals', async () => {
    const res = await admin.get(`/api/reports/daily?${last30()}&format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="daily-.*\.csv"/);
    const text = res.text;
    expect(text).toContain('Report Co');
    expect(text).toContain('Daily Financial Report');
    expect(text).toContain(`Period: ${daysAgo(29)} to ${today()}`);
    expect(text).toContain('Currency: INR');
    expect(text).toMatch(/Generated: \d{4}-/);
    const lastLine = text.trim().split('\r\n').at(-1)!.split(',');
    expect(lastLine[0]).toBe('Total');
    expect(lastLine[2]).toBe('10000.00');
    expect(lastLine[3]).toBe('4500.00');
  });

  it('Excel and PDF exports are real files', async () => {
    const xlsx = await binary(admin.get(`/api/reports/profit-loss?${last30()}&format=xlsx`));
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK'); // zip container
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as never);
    const cells: unknown[] = [];
    wb.worksheets[0].eachRow((row) => row.eachCell((cell) => cells.push(cell.value)));
    expect(cells).toContain('Report Co');
    expect(cells).toContain(5500); // Net Profit as a real number, not text

    for (const key of ['daily', 'profit-loss', 'cash-flow', 'receivables']) {
      const pdf = await binary(admin.get(`/api/reports/${key}?${last30()}&format=pdf`));
      expect(pdf.status, key).toBe(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    }
    const txns = await admin.get(`/api/transactions?format=csv`);
    expect(txns.status).toBe(200);
    expect(txns.text).toContain('Transaction ID');
    expect(await prisma.auditLog.count({ where: { companyId: c.companyId, action: 'export' } })).toBeGreaterThanOrEqual(6);
  });

  it('unknown reports and formats are rejected', async () => {
    expect((await admin.get('/api/reports/nope')).status).toBe(404);
    expect((await admin.get('/api/reports/daily?format=exe')).status).toBe(400);
    expect((await admin.get(`/api/reports/daily?from=${daysAgo(800)}&to=${today()}`)).status).toBe(400);
  });
});

describe('empty company', () => {
  it('returns zeros and empty reports, never sample data', async () => {
    const empty = await bootstrapCompany('Empty Co');
    const s = (await empty.admin.get('/api/dashboard/summary')).body.data;
    expect(s.hasAnyData).toBe(false);
    for (const k of ['totalIncome', 'totalExpenses', 'grossProfit', 'netProfit', 'cashBalance', 'bankBalance', 'receivables', 'payables', 'onlineReceipts', 'pendingPayments']) expect(s[k], k).toBe('0.00');
    expect((await empty.admin.get('/api/transactions')).body.data).toEqual([]);
    const ie = (await empty.admin.get('/api/dashboard/income-expenses')).body.data;
    expect(ie.series.every((x: { income: string; expenses: string }) => x.income === '0.00' && x.expenses === '0.00')).toBe(true);
    for (const key of ['income', 'expenses', 'receivables', 'payables', 'online-payments', 'customer-transactions', 'tax-summary']) {
      const r = (await empty.admin.get(`/api/reports/${key}`)).body.data;
      expect(r.rows, key).toHaveLength(0);
    }
    const pdf = await binary(empty.admin.get('/api/reports/income?format=pdf'));
    expect(pdf.status).toBe(200);
    expect(await prisma.transaction.count({ where: { companyId: empty.companyId } })).toBe(0);
  });

  it('company profile validation (missing and invalid information)', async () => {
    const { admin: a2 } = await bootstrapCompany('Profile Co');
    expect((await a2.patch('/api/company', { name: '' })).status).toBe(400);
    expect((await a2.patch('/api/company', { gstin: '27AAPFU0939F1ZX' })).body.error.details.fields.gstin).toBeTruthy();
    expect((await a2.patch('/api/company', { pan: 'BAD' })).status).toBe(400);
    expect((await a2.patch('/api/company', { gstin: '27AAPFU0939F1ZV', pan: 'ZZZZZ9999Z' })).body.error.details.fields.pan).toBeTruthy();
    expect((await a2.patch('/api/company', { postalCode: '12' })).status).toBe(400);
    expect((await a2.patch('/api/company', { website: 'not a url' })).status).toBe(400);
    const ok = await a2.patch('/api/company', { gstin: '27aapfu0939f1zv', pan: 'AAPFU0939F', postalCode: '400001', city: 'Mumbai', website: 'https://example.com' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.gstin).toBe('27AAPFU0939F1ZV');
    // Optional identifiers can be cleared again.
    const cleared = await a2.patch('/api/company', { gstin: '', pan: '', registrationNumber: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.gstin).toBeNull();
    const log = await prisma.auditLog.findFirst({ where: { action: 'company.update', companyId: ok.body.data.id } });
    expect(log).toBeTruthy();
    // The currency is locked once the books have entries.
    const accounts = (await a2.get('/api/accounts')).body.data as Array<{ id: string; kind: string }>;
    const cats = (await a2.get('/api/categories?type=INCOME')).body.data as Array<{ id: string }>;
    await a2.post('/api/income', { date: today(), categoryId: cats[0].id, amount: '1', paymentMethod: 'CASH', accountId: accounts.find((x) => x.kind === 'CASH')!.id }, idem());
    expect((await a2.patch('/api/company', { baseCurrency: 'USD' })).status).toBe(422);
  });
});

describe('audit log', () => {
  it('records who did what, is filterable, and contains no secrets', async () => {
    const res = await admin.get('/api/audit-logs?pageSize=200');
    expect(res.status).toBe(200);
    const actions = new Set(res.body.data.map((l: { action: string }) => l.action));
    for (const a of ['transaction.create', 'transaction.reverse', 'invoice.create', 'invoice.issue', 'payment.create', 'payment.status', 'settings.update', 'company.create', 'account.create', 'customer.create', 'export']) expect(actions, a).toContain(a);
    const one = res.body.data[0];
    expect(one.userName).toBeTruthy();
    expect(one.companyId).toBe(c.companyId);
    expect(one.createdAt).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|passwordHash|tokenHash|csrf/i);
    const filtered = await admin.get('/api/audit-logs?action=transaction.reverse');
    expect(filtered.body.data.every((l: { action: string }) => l.action === 'transaction.reverse')).toBe(true);
    expect(filtered.body.data[0].summary).toContain('Entered by mistake yesterday');
  });

  it('exposes no way to change or delete audit records', async () => {
    const id = (await admin.get('/api/audit-logs')).body.data[0].id;
    expect((await admin.patch(`/api/audit-logs/${id}`, { summary: 'x' })).status).toBe(404);
    expect((await admin.post(`/api/audit-logs/${id}/delete`)).status).toBe(404);
    const viewer = (await addUser(admin, 'VIEWER')).client;
    expect((await viewer.get('/api/audit-logs')).status).toBe(403);
  });
});
