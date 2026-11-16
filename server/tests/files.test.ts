import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { addUser, app, bootstrapCompany, Client, daysAgo, idem, prisma, resetDb, today } from './helpers';

type Ctx = Awaited<ReturnType<typeof bootstrapCompany>>;
let a: Ctx, b: Ctx;
let admin: Client, viewer: Client, accountant: Client;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const upload = (c: Client, url: string, data: Buffer, name: string) => request(app).post(url).set('Cookie', c.cookie).set('X-CSRF-Token', c.csrf).attach('file', data, name);
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

beforeAll(async () => {
  await resetDb();
  a = await bootstrapCompany('Files Co');
  b = await bootstrapCompany('Other Co');
  admin = a.admin;
  viewer = (await addUser(admin, 'VIEWER')).client;
  accountant = (await addUser(admin, 'ACCOUNTANT')).client;
});

describe('file uploads', () => {
  it('stores a company logo and serves it back', async () => {
    const res = await upload(admin, '/api/company/logo', PNG, 'logo.png');
    expect(res.status).toBe(201);
    const got = await admin.get('/api/company/logo');
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['x-content-type-options']).toBe('nosniff');
    expect((await admin.get('/api/company')).body.data.logoAttachmentId).toBe(res.body.data.logoAttachmentId);
    expect(await prisma.auditLog.count({ where: { companyId: a.companyId, action: 'company.logo' } })).toBe(1);
  });

  it('decides the type from file content, not the file name', async () => {
    const fake = await upload(admin, '/api/company/logo', Buffer.from('<html><script>alert(1)</script></html>'), 'logo.png');
    expect(fake.status).toBe(400);
    expect(fake.body.error.code).toBe('UPLOAD_ERROR');
    expect((await upload(admin, '/api/company/logo', PDF, 'logo.png')).status).toBe(400); // a PDF is not an allowed logo type
    expect((await upload(admin, '/api/attachments', Buffer.from('MZ fake executable content here'), 'receipt.pdf')).status).toBe(400);
    expect((await request(app).post('/api/attachments').set('Cookie', admin.cookie).set('X-CSRF-Token', admin.csrf)).status).toBe(400); // no file at all
  });

  it('rejects files over the size limit', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
    const res = await upload(admin, '/api/attachments', big, 'huge.png');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/too large/i);
  });

  it('attaches a receipt to an expense and restricts who can read it', async () => {
    const up = await upload(accountant, '/api/attachments', PDF, '../../evil name?.pdf');
    expect(up.status).toBe(201);
    expect(up.body.data.fileName).not.toMatch(/[\\/]/); // path components are stripped
    const stored = await prisma.attachment.findUniqueOrThrow({ where: { id: up.body.data.id } });
    expect(stored.storedName).not.toContain('evil'); // stored under a random name

    await admin.post('/api/income', { date: today(), categoryId: a.cat('Product Sales'), amount: '5000', paymentMethod: 'CASH', accountId: a.cashId }, idem());
    const exp = await accountant.post('/api/expenses', { date: today(), categoryId: a.cat('Utilities'), amount: '120', paymentMethod: 'CASH', accountId: a.cashId, attachmentId: up.body.data.id }, idem());
    expect(exp.status).toBe(201);
    const detail = (await admin.get(`/api/transactions/${exp.body.data.id}`)).body.data;
    expect(detail.attachment.id).toBe(up.body.data.id);

    const file = await viewer.get(`/api/attachments/${up.body.data.id}/file`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-disposition']).toMatch(/^attachment/);

    // Another company can neither read the file nor reference it.
    expect((await b.admin.get(`/api/attachments/${up.body.data.id}/file`)).status).toBe(404);
    const steal = await b.admin.post('/api/income', { date: today(), categoryId: b.cat('Product Sales'), amount: '1', paymentMethod: 'CASH', accountId: b.cashId, attachmentId: up.body.data.id });
    expect(steal.status).toBe(400);
    expect((await request(app).get(`/api/attachments/${up.body.data.id}/file`)).status).toBe(401);
  });

  it('enforces upload permissions', async () => {
    expect((await upload(viewer, '/api/attachments', PDF, 'r.pdf')).status).toBe(403);
    expect((await upload(accountant, '/api/company/logo', PNG, 'logo.png')).status).toBe(403);
    expect((await request(app).post('/api/attachments').set('Cookie', admin.cookie).attach('file', PDF, 'r.pdf')).status).toBe(403); // no CSRF token
  });
});

describe('bank statement import and reconciliation', () => {
  const recon = async (c: Client = admin) => (await c.get(`/api/accounts/${a.bankId}/reconciliation`)).body.data;
  const importCsv = (csv: string, c: Client = admin, accountId = a.bankId) => c.post(`/api/accounts/${accountId}/statement-import`, { csv });
  let csv: string;

  beforeAll(async () => {
    const ok = (r: { status: number; body: unknown }) => { if (r.status !== 201) throw new Error(JSON.stringify(r.body)); };
    ok(await admin.post('/api/income', { date: daysAgo(2), categoryId: a.cat('Service Revenue'), amount: '1000', paymentMethod: 'UPI', accountId: a.bankId }, idem()));
    ok(await admin.post('/api/expenses', { date: daysAgo(1), categoryId: a.cat('Rent'), amount: '300', paymentMethod: 'BANK_TRANSFER', accountId: a.bankId }, idem()));
    ok(await admin.post('/api/income', { date: today(), categoryId: a.cat('Product Sales'), amount: '500', paymentMethod: 'NET_BANKING', accountId: a.bankId }, idem()));
    // Mixed date formats, quoted text with a comma, thousands separators, a blank line and a zero row.
    csv = [
      'Date,Narration,Ref No,Withdrawal,Deposit',
      `${daysAgo(1)},"UPI/CR/ACME, LTD",UTR1,,"1,000.00"`, // statement shows it a day later than the books
      `${ddmmyyyy(daysAgo(1))},RENT NOV,CHQ22,300.00,`,
      `${today()},UNKNOWN DEPOSIT,UTR3,,777.00`,
      '',
      `${today()},ZERO ROW,,0,0`,
    ].join('\r\n');
  });

  it('imports a statement and skips rows already imported', async () => {
    const first = await importCsv(csv);
    expect(first.status).toBe(201);
    expect(first.body.data).toEqual({ imported: 3, skippedDuplicates: 0 });
    const again = await importCsv(csv);
    expect(again.body.data).toEqual({ imported: 0, skippedDuplicates: 3 });

    const r = await recon();
    expect(r.statementLines).toHaveLength(3);
    expect(r.statementLines.map((s: { amount: string }) => s.amount).sort()).toEqual(['-300.00', '1000.00', '777.00']);
    expect(r.statementLines.find((s: { reference: string }) => s.reference === 'UTR1').description).toBe('UPI/CR/ACME, LTD');
    expect(r.bookEntries).toHaveLength(3);
    expect(r.bookBalance).toBe('1200.00');
    expect(r.reconciledBalance).toBe('0.00');
    expect(await prisma.auditLog.count({ where: { companyId: a.companyId, action: 'statement.import' } })).toBe(2);
  });

  it('rejects malformed statements without importing anything', async () => {
    const before = await prisma.bankStatementLine.count();
    expect((await importCsv('Narration,Amount\nX,10')).status).toBe(400); // no date column
    expect((await importCsv('Date,Description\n2026-01-01,X')).status).toBe(400); // no amount columns
    expect((await importCsv('Date,Amount')).status).toBe(400); // header only
    expect((await importCsv('')).status).toBe(400);
    const badRow = await importCsv(`Date,Amount\n${today()},100\n31/02/2026,50\n${today()},abc`);
    expect(badRow.status).toBe(400);
    expect(badRow.body.error.message).toMatch(/Row 3/);
    expect(badRow.body.error.message).toMatch(/Row 4/);
    expect(await prisma.bankStatementLine.count()).toBe(before); // all-or-nothing
  });

  it('applies permissions and company isolation', async () => {
    expect((await importCsv(csv, viewer)).status).toBe(403);
    expect((await importCsv(csv, b.admin)).status).toBe(404);
    expect((await importCsv(csv, admin, a.cashId)).status).toBe(404); // cash accounts have no bank statement
    expect((await viewer.get(`/api/accounts/${a.bankId}/reconciliation`)).status).toBe(200);
    expect((await b.admin.get(`/api/accounts/${a.bankId}/reconciliation`)).status).toBe(404);
    expect((await viewer.post(`/api/accounts/${a.bankId}/reconciliation/auto-match`)).status).toBe(403);
    expect((await b.admin.post(`/api/accounts/${a.bankId}/reconciliation/auto-match`)).status).toBe(404);
  });

  it('auto-matches equal amounts on nearby dates and leaves the rest', async () => {
    const res = await accountant.post(`/api/accounts/${a.bankId}/reconciliation/auto-match`);
    expect(res.status).toBe(200);
    expect(res.body.data.matched).toBe(2);
    const r = await recon();
    expect(r.statementLines).toHaveLength(1);
    expect(r.statementLines[0].amount).toBe('777.00');
    expect(r.bookEntries).toHaveLength(1);
    expect(r.bookEntries[0].amount).toBe('500.00');
    expect(r.reconciledBalance).toBe('700.00'); // 1000 − 300
    expect(r.unreconciledIn).toBe('500.00');
    expect((await accountant.post(`/api/accounts/${a.bankId}/reconciliation/auto-match`)).body.data.matched).toBe(0);
    // Reconciling never changes the books.
    expect(r.bookBalance).toBe('1200.00');
  });

  it('refuses to match different amounts or items already reconciled', async () => {
    const r = await recon();
    const mismatch = await admin.post(`/api/accounts/${a.bankId}/reconciliation/match`, { statementLineId: r.statementLines[0].id, entryId: r.bookEntries[0].id });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.code).toBe('AMOUNT_MISMATCH');
    const done = await prisma.accountTransaction.findFirstOrThrow({ where: { accountId: a.bankId, NOT: { reconciledAt: null } } });
    const twice = await admin.post(`/api/accounts/${a.bankId}/reconciliation/match`, { statementLineId: r.statementLines[0].id, entryId: done.id });
    expect(twice.status).toBe(422);
    expect(twice.body.error.code).toBe('ALREADY_RECONCILED');
    expect((await admin.post(`/api/accounts/${a.bankId}/reconciliation/match`, { statementLineId: 'nope', entryId: r.bookEntries[0].id })).status).toBe(404);
  });

  it('matches manually, marks without a statement line, and can undo', async () => {
    // A statement line that equals the remaining book entry, more than 3 days away (so auto-match skips it).
    await importCsv(`Date,Description,Amount\n${daysAgo(9)},LATE POSTED,500.00`);
    expect((await admin.post(`/api/accounts/${a.bankId}/reconciliation/auto-match`)).body.data.matched).toBe(0);
    let r = await recon();
    const line = r.statementLines.find((s: { amount: string }) => s.amount === '500.00');
    const entry = r.bookEntries[0];
    expect((await admin.post(`/api/accounts/${a.bankId}/reconciliation/match`, { statementLineId: line.id, entryId: entry.id })).status).toBe(200);
    r = await recon();
    expect(r.bookEntries).toHaveLength(0);
    expect(r.reconciledBalance).toBe(r.bookBalance);

    expect((await admin.post(`/api/accounts/${a.bankId}/reconciliation/unmatch`, { entryId: entry.id })).status).toBe(200);
    r = await recon();
    expect(r.bookEntries).toHaveLength(1);
    expect(r.statementLines.some((s: { id: string }) => s.id === line.id)).toBe(true); // the statement line is free again

    expect((await admin.post(`/api/accounts/${a.bankId}/reconciliation/mark`, { entryId: entry.id, reconciled: true })).status).toBe(200);
    expect((await recon()).bookEntries).toHaveLength(0);
    const book = (await admin.get(`/api/accounts/${a.bankId}/transactions`)).body.data;
    expect(book.every((x: { reconciledAt: string | null }) => x.reconciledAt)).toBe(true);
    expect((await viewer.post(`/api/accounts/${a.bankId}/reconciliation/mark`, { entryId: entry.id, reconciled: false })).status).toBe(403);
  });
});

describe('user invitation', () => {
  it('an invited user cannot sign in until they set a password through the emailed link', async () => {
    const email = 'invitee@example.com';
    const created = await admin.post('/api/users', { fullName: 'Invited Person', email, role: 'ACCOUNTANT' });
    expect(created.status).toBe(201);
    expect(created.body.data.emailVerified).toBe(false);
    expect(JSON.stringify(created.body)).not.toMatch(/token|password/i);
    expect((await new Client().login(email, 'Any-Passw0rd-123')).status).toBe(401);
    expect((await admin.post('/api/users', { fullName: 'Invited Person', email, role: 'VIEWER' })).status).toBe(409);
    expect((await admin.post('/api/users', { fullName: 'X', email: 'bad', role: 'VIEWER' })).status).toBe(400);
    expect((await admin.post('/api/users', { fullName: 'Role Test', email: 'role@example.com', role: 'OWNER' })).status).toBe(400);
  });

  it('a self-registered user gets access only when an admin adds their email', async () => {
    const email = 'selfreg@example.com';
    const pw = 'Self-Reg-Passw0rd';
    await request(app).post('/api/auth/signup').send({ fullName: 'Self Registered', email, phone: '+91 90000 00000', password: pw, confirmPassword: pw });
    await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
    const c = new Client();
    expect((await c.login(email, pw)).status).toBe(200);
    expect((await c.get('/api/transactions')).status).toBe(403);

    const grant = await admin.post('/api/users', { fullName: 'Ignored', email, role: 'ACCOUNTANT' });
    expect(grant.status).toBe(201);
    expect(grant.body.data.role).toBe('ACCOUNTANT');
    expect((await c.get('/api/transactions')).status).toBe(200); // same session, now attached to the company
    expect((await c.get('/api/users')).status).toBe(403);
    expect((await b.admin.get('/api/users')).body.data.some((u: { email: string }) => u.email === email)).toBe(false);
  });
});
