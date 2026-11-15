import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { prisma, Prisma } from '../db';
import { parse, zDate, zDateOptional, zId, zMoneyOptional, zPage, zText } from '../lib/validate';
import { AppError, notFound, unprocessable } from '../lib/errors';
import { audit, auditCtx } from '../lib/audit';
import { D, money, ZERO } from '../lib/money';
import { fmtDate, isValidDate, parseDate, today } from '../lib/dates';
import { nextSequence } from '../lib/sequence';
import { companyOf, h, requirePerm } from '../middleware/auth';
import { idempotent } from '../middleware/idempotency';
import { accountBalance, balancesByAccount } from '../services/ledger';
import { createOpeningBalance } from '../services/transactions';
import { actorOf } from './helpers';

export const accountsRouter = Router();

const accountSchema = z
  .object({
    kind: z.enum(['CASH', 'BANK']),
    name: z.string({ required_error: 'Account name is required' }).trim().min(2, 'Account name is required').max(80),
    bankName: zText(80),
    bankAccountType: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(['CURRENT', 'SAVINGS', 'OVERDRAFT', 'CASH_CREDIT', 'OTHER']).optional()),
    accountNumber: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().regex(/^[0-9Xx* -]{4,24}$/, 'Enter digits only (it is stored masked)').optional()),
    openingBalance: zMoneyOptional,
    openingDate: zDateOptional,
  })
  .refine((d) => d.kind !== 'BANK' || Boolean(d.bankName), { path: ['bankName'], message: 'Bank name is required' });

/** Only the last four digits are ever stored. */
const mask = (n?: string) => {
  if (!n) return null;
  const digits = n.replace(/[^0-9]/g, '');
  return digits.length >= 4 ? 'XXXX' + digits.slice(-4) : null;
};

accountsRouter.get('/', requirePerm('accounts.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const q = parse(z.object({ kind: z.enum(['CASH', 'BANK', 'ALL']).default('ALL'), asOf: zDateOptional }), req.query);
  const accounts = await prisma.account.findMany({
    where: { companyId, subtype: q.kind === 'ALL' ? { in: ['CASH', 'BANK'] } : q.kind },
    orderBy: [{ subtype: 'asc' }, { name: 'asc' }],
  });
  const balances = await balancesByAccount(prisma, companyId, q.asOf);
  res.json({
    data: accounts.map((a) => ({
      id: a.id, code: a.code, name: a.name, kind: a.subtype, bankName: a.bankName, bankAccountType: a.bankAccountType,
      accountNumberMasked: a.accountNumberMasked, openingBalance: money(a.openingBalance), openingDate: a.openingDate ? fmtDate(a.openingDate) : null,
      isActive: a.isActive, balance: money(balances.get(a.id) ?? ZERO),
    })),
  });
}));

accountsRouter.post('/', requirePerm('accounts.manage'), idempotent, h(async (req, res) => {
  const companyId = companyOf(req);
  const d = parse(accountSchema, req.body);
  const account = await prisma.$transaction(async (tx) => {
    if (await tx.account.findFirst({ where: { companyId, subtype: d.kind, name: { equals: d.name, mode: 'insensitive' } } })) {
      throw new AppError(409, 'CONFLICT', 'An account with this name already exists', { fields: { name: 'Already in use' } });
    }
    const seq = await nextSequence(tx, companyId, d.kind === 'CASH' ? 'ACC_CASH' : 'ACC_BANK');
    const code = String((d.kind === 'CASH' ? 1000 : 1100) + seq).padStart(4, '0') + (seq > 99 ? `-${seq}` : '');
    const openingDate = parseDate(d.openingDate ?? today());
    const a = await tx.account.create({
      data: {
        companyId, code, name: d.name, type: 'ASSET', subtype: d.kind,
        bankName: d.kind === 'BANK' ? d.bankName ?? null : null,
        bankAccountType: d.kind === 'BANK' ? d.bankAccountType ?? null : null,
        accountNumberMasked: d.kind === 'BANK' ? mask(d.accountNumber) : null,
        openingBalance: d.openingBalance, openingDate,
      },
    });
    await createOpeningBalance(tx, actorOf(req), a, d.openingBalance, openingDate);
    await audit(tx, { ...auditCtx(req), action: 'account.create', entityType: 'Account', entityId: a.id, summary: `Created ${d.kind.toLowerCase()} account "${a.name}" with opening balance ${d.openingBalance.toFixed(2)}` });
    return a;
  });
  res.status(201).json({ data: { id: account.id, name: account.name, kind: account.subtype } });
}));

accountsRouter.patch('/:id', requirePerm('accounts.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const acc = await prisma.account.findFirst({ where: { id: req.params.id, companyId, subtype: { in: ['CASH', 'BANK'] } } });
  if (!acc) throw notFound('Account');
  const d = parse(z.object({ name: z.string().trim().min(2).max(80).optional(), bankName: zText(80), bankAccountType: zText(20), isActive: z.boolean().optional() }), req.body);
  if (d.isActive === false && !(await accountBalance(prisma, companyId, acc.id)).isZero()) {
    throw unprocessable('Only accounts with a zero balance can be deactivated. Transfer the balance first.');
  }
  const a = await prisma.account.update({
    where: { id: acc.id },
    data: { name: d.name ?? acc.name, bankName: d.bankName ?? acc.bankName, bankAccountType: d.bankAccountType ?? acc.bankAccountType, isActive: d.isActive ?? acc.isActive },
  });
  await audit(prisma, { ...auditCtx(req), action: 'account.update', entityType: 'Account', entityId: a.id, summary: `Updated account "${acc.name}"${d.isActive !== undefined && d.isActive !== acc.isActive ? ` — ${d.isActive ? 'activated' : 'deactivated'}` : ''}` });
  res.json({ data: { id: a.id, name: a.name, isActive: a.isActive } });
}));

// Account book with a running balance. The balance is computed over the whole history, then the page is cut.
accountsRouter.get('/:id/transactions', requirePerm('accounts.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const acc = await prisma.account.findFirst({ where: { id: req.params.id, companyId, subtype: { in: ['CASH', 'BANK'] } } });
  if (!acc) throw notFound('Account');
  const q = parse(zPage.extend({ from: zDateOptional, to: zDateOptional }), req.query);
  const from = q.from ?? '0001-01-01', to = q.to ?? '9999-12-31';
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT * FROM (
      SELECT x."id", x."date", x."direction"::text AS direction, x."amount", x."paymentMethod"::text AS "paymentMethod", x."reconciledAt",
             t."id" AS "transactionId", t."number", t."type"::text AS type, t."description", t."reference", t."isReversal", t."status"::text AS status,
             SUM(CASE WHEN x."direction" = 'IN' THEN x."amount" ELSE -x."amount" END) OVER (ORDER BY x."date", x."createdAt", x."id") AS balance
      FROM "AccountTransaction" x JOIN "Transaction" t ON t."id" = x."transactionId"
      WHERE x."companyId" = ${companyId} AND x."accountId" = ${acc.id}
    ) b
    WHERE b."date" BETWEEN ${from}::date AND ${to}::date
    ORDER BY b."date" DESC, b."balance" DESC, b."id" DESC
    LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`;
  const agg = await prisma.$queryRaw<{ total: bigint; inflow: Prisma.Decimal | null; outflow: Prisma.Decimal | null; opening: Prisma.Decimal | null }[]>`
    SELECT COUNT(*) FILTER (WHERE x."date" BETWEEN ${from}::date AND ${to}::date) AS total,
           SUM(x."amount") FILTER (WHERE x."direction" = 'IN' AND x."date" BETWEEN ${from}::date AND ${to}::date) AS inflow,
           SUM(x."amount") FILTER (WHERE x."direction" = 'OUT' AND x."date" BETWEEN ${from}::date AND ${to}::date) AS outflow,
           SUM(CASE WHEN x."direction" = 'IN' THEN x."amount" ELSE -x."amount" END) FILTER (WHERE x."date" < ${from}::date) AS opening
    FROM "AccountTransaction" x WHERE x."companyId" = ${companyId} AND x."accountId" = ${acc.id}`;
  const opening = D(agg[0].opening), inflow = D(agg[0].inflow), outflow = D(agg[0].outflow);
  res.json({
    data: rows.map((r) => ({ ...r, date: fmtDate(r.date as Date), amount: money(r.amount as never), balance: money(r.balance as never) })),
    meta: {
      page: q.page, pageSize: q.pageSize, total: Number(agg[0].total),
      account: { id: acc.id, name: acc.name, kind: acc.subtype, bankName: acc.bankName, accountNumberMasked: acc.accountNumberMasked, isActive: acc.isActive },
      summary: { opening: money(opening), inflow: money(inflow), outflow: money(outflow), closing: money(opening.plus(inflow).minus(outflow)), bookBalance: money(await accountBalance(prisma, companyId, acc.id)) },
    },
  });
}));

// ───────────────────────── Bank reconciliation ─────────────────────────

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function statementDate(v: string): string | null {
  const s = v.trim();
  if (isValidDate(s)) return s;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // DD/MM/YYYY
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    if (isValidDate(iso)) return iso;
  }
  return null;
}
const statementAmount = (v: string | undefined) => {
  const s = (v ?? '').replace(/[,\s₹]/g, '');
  if (!s) return null;
  return /^-?\d{1,13}(\.\d{1,2})?$/.test(s) ? D(s) : undefined; // undefined = unparseable
};

accountsRouter.post('/:id/statement-import', requirePerm('reconciliation.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const acc = await prisma.account.findFirst({ where: { id: req.params.id, companyId, subtype: 'BANK' } });
  if (!acc) throw notFound('Bank account');
  const { csv } = parse(z.object({ csv: z.string().min(1, 'The file is empty').max(2_000_000, 'The file is too large (max 2 MB)') }), req.body);
  const rows = parseCsv(csv);
  if (rows.length < 2) throw new AppError(400, 'IMPORT_ERROR', 'The file needs a header row and at least one transaction row');
  const header = rows[0].map((c) => c.trim().toLowerCase());
  const find = (...names: string[]) => header.findIndex((c) => names.some((n) => c === n || c.startsWith(n)));
  const col = { date: find('date', 'txn date', 'transaction date', 'value date'), desc: find('description', 'narration', 'particulars', 'details'), ref: find('reference', 'ref', 'cheque', 'chq', 'utr'), debit: find('debit', 'withdrawal'), credit: find('credit', 'deposit'), amount: find('amount') };
  if (col.date < 0 || (col.amount < 0 && (col.debit < 0 || col.credit < 0))) {
    throw new AppError(400, 'IMPORT_ERROR', 'Required columns: Date, and either Amount or both Debit and Credit. Optional: Description, Reference.');
  }
  const errors: string[] = [];
  const lines: Array<{ date: string; description: string | null; reference: string | null; amount: Prisma.Decimal; fingerprint: string }> = [];
  const seen = new Map<string, number>();
  rows.slice(1).forEach((r, i) => {
    const n = i + 2;
    const date = statementDate(r[col.date] ?? '');
    if (!date) return errors.push(`Row ${n}: invalid date "${r[col.date] ?? ''}"`);
    let amount: Prisma.Decimal | null | undefined;
    if (col.amount >= 0) amount = statementAmount(r[col.amount]);
    else {
      const debit = statementAmount(r[col.debit]), credit = statementAmount(r[col.credit]);
      amount = debit === undefined || credit === undefined ? undefined : (credit ?? ZERO).minus(debit ?? ZERO);
    }
    if (amount === undefined || amount === null) return errors.push(`Row ${n}: invalid amount`);
    if (amount.isZero()) return;
    const description = col.desc >= 0 ? (r[col.desc] ?? '').trim().slice(0, 300) || null : null;
    const reference = col.ref >= 0 ? (r[col.ref] ?? '').trim().slice(0, 100) || null : null;
    const base = [date, amount.toFixed(2), description ?? '', reference ?? ''].join('|');
    const occurrence = (seen.get(base) ?? 0) + 1; // identical rows in one statement are distinct movements
    seen.set(base, occurrence);
    lines.push({ date, description, reference, amount, fingerprint: crypto.createHash('sha256').update(base + '|' + occurrence).digest('hex') });
  });
  if (errors.length) throw new AppError(400, 'IMPORT_ERROR', `The statement could not be imported: ${errors.slice(0, 5).join('; ')}${errors.length > 5 ? ` (+${errors.length - 5} more)` : ''}`);
  if (lines.length > 5000) throw new AppError(400, 'IMPORT_ERROR', 'A statement can contain at most 5,000 rows');
  const result = await prisma.bankStatementLine.createMany({
    data: lines.map((l) => ({ companyId, accountId: acc.id, date: parseDate(l.date), description: l.description, reference: l.reference, amount: l.amount, fingerprint: l.fingerprint, importedById: req.auth!.userId })),
    skipDuplicates: true,
  });
  await audit(prisma, { ...auditCtx(req), action: 'statement.import', entityType: 'Account', entityId: acc.id, summary: `Imported ${result.count} statement line(s) into "${acc.name}" (${lines.length - result.count} duplicate(s) skipped)` });
  res.status(201).json({ data: { imported: result.count, skippedDuplicates: lines.length - result.count } });
}));

accountsRouter.get('/:id/reconciliation', requirePerm('accounts.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const acc = await prisma.account.findFirst({ where: { id: req.params.id, companyId, subtype: 'BANK' } });
  if (!acc) throw notFound('Bank account');
  const [book, statement, bookBalance, counts] = await Promise.all([
    prisma.accountTransaction.findMany({ where: { companyId, accountId: acc.id, reconciledAt: null }, include: { transaction: { select: { number: true, description: true, reference: true, type: true } } }, orderBy: { date: 'asc' }, take: 500 }),
    prisma.bankStatementLine.findMany({ where: { companyId, accountId: acc.id, matchedId: null }, orderBy: { date: 'asc' }, take: 500 }),
    accountBalance(prisma, companyId, acc.id),
    prisma.accountTransaction.groupBy({ by: ['direction'], where: { companyId, accountId: acc.id, reconciledAt: null }, _sum: { amount: true } }),
  ]);
  const unrecIn = D(counts.find((c) => c.direction === 'IN')?._sum.amount), unrecOut = D(counts.find((c) => c.direction === 'OUT')?._sum.amount);
  res.json({
    data: {
      account: { id: acc.id, name: acc.name, bankName: acc.bankName },
      bookBalance: money(bookBalance),
      reconciledBalance: money(bookBalance.minus(unrecIn).plus(unrecOut)),
      unreconciledIn: money(unrecIn),
      unreconciledOut: money(unrecOut),
      bookEntries: book.map((b) => ({ id: b.id, date: fmtDate(b.date), direction: b.direction, amount: money(b.amount), number: b.transaction.number, type: b.transaction.type, description: b.transaction.description, reference: b.transaction.reference })),
      statementLines: statement.map((s) => ({ id: s.id, date: fmtDate(s.date), description: s.description, reference: s.reference, amount: money(s.amount) })),
    },
  });
}));

async function matchPair(companyId: string, accountId: string, userId: string, statementLineId: string, entryId: string) {
  return prisma.$transaction(async (tx) => {
    const line = await tx.bankStatementLine.findFirst({ where: { id: statementLineId, companyId, accountId } });
    const entry = await tx.accountTransaction.findFirst({ where: { id: entryId, companyId, accountId } });
    if (!line || !entry) throw notFound('Statement line or book entry');
    if (line.matchedId || entry.reconciledAt) throw unprocessable('One of these items is already reconciled', 'ALREADY_RECONCILED');
    const signed = entry.direction === 'IN' ? entry.amount : entry.amount.negated();
    if (!signed.eq(line.amount)) throw unprocessable(`Amounts differ: statement ${line.amount.toFixed(2)} vs book ${signed.toFixed(2)}`, 'AMOUNT_MISMATCH');
    await tx.bankStatementLine.update({ where: { id: line.id }, data: { matchedId: entry.id } });
    await tx.accountTransaction.update({ where: { id: entry.id }, data: { reconciledAt: new Date(), reconciledById: userId } });
  });
}

accountsRouter.post('/:id/reconciliation/match', requirePerm('reconciliation.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const d = parse(z.object({ statementLineId: zId, entryId: zId }), req.body);
  await matchPair(companyId, req.params.id, req.auth!.userId, d.statementLineId, d.entryId);
  await audit(prisma, { ...auditCtx(req), action: 'reconciliation.match', entityType: 'AccountTransaction', entityId: d.entryId, summary: 'Matched a bank statement line to a book entry' });
  res.json({ data: { matched: 1 } });
}));

accountsRouter.post('/:id/reconciliation/auto-match', requirePerm('reconciliation.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const accountId = req.params.id;
  if (!(await prisma.account.findFirst({ where: { id: accountId, companyId, subtype: 'BANK' } }))) throw notFound('Bank account');
  // Same signed amount, dates within 3 days, and the pairing is unambiguous on both sides.
  const pairs = await prisma.$queryRaw<{ lineId: string; entryId: string }[]>`
    WITH c AS (
      SELECT s."id" AS "lineId", x."id" AS "entryId",
             COUNT(*) OVER (PARTITION BY s."id") AS n1, COUNT(*) OVER (PARTITION BY x."id") AS n2
      FROM "BankStatementLine" s
      JOIN "AccountTransaction" x ON x."accountId" = s."accountId" AND x."reconciledAt" IS NULL
        AND (CASE WHEN x."direction" = 'IN' THEN x."amount" ELSE -x."amount" END) = s."amount"
        AND ABS(x."date" - s."date") <= 3
      WHERE s."companyId" = ${companyId} AND s."accountId" = ${accountId} AND s."matchedId" IS NULL
    ) SELECT "lineId", "entryId" FROM c WHERE n1 = 1 AND n2 = 1`;
  let matched = 0;
  for (const p of pairs) {
    try { await matchPair(companyId, accountId, req.auth!.userId, p.lineId, p.entryId); matched++; } catch { /* raced with another user: skip */ }
  }
  if (matched) await audit(prisma, { ...auditCtx(req), action: 'reconciliation.auto_match', entityType: 'Account', entityId: accountId, summary: `Auto-matched ${matched} statement line(s)` });
  res.json({ data: { matched } });
}));

accountsRouter.post('/:id/reconciliation/unmatch', requirePerm('reconciliation.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const { entryId } = parse(z.object({ entryId: zId }), req.body);
  const entry = await prisma.accountTransaction.findFirst({ where: { id: entryId, companyId, accountId: req.params.id } });
  if (!entry) throw notFound('Book entry');
  await prisma.$transaction([
    prisma.bankStatementLine.updateMany({ where: { matchedId: entry.id, companyId }, data: { matchedId: null } }),
    prisma.accountTransaction.update({ where: { id: entry.id }, data: { reconciledAt: null, reconciledById: null } }),
  ]);
  await audit(prisma, { ...auditCtx(req), action: 'reconciliation.unmatch', entityType: 'AccountTransaction', entityId: entry.id, summary: 'Removed a reconciliation match' });
  res.json({ data: { unmatched: 1 } });
}));

// Tick off a book entry that has no imported statement line (e.g. checked against a paper statement).
accountsRouter.post('/:id/reconciliation/mark', requirePerm('reconciliation.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const d = parse(z.object({ entryId: zId, reconciled: z.boolean() }), req.body);
  const entry = await prisma.accountTransaction.findFirst({ where: { id: d.entryId, companyId, accountId: req.params.id } });
  if (!entry) throw notFound('Book entry');
  if (!d.reconciled) await prisma.bankStatementLine.updateMany({ where: { matchedId: entry.id, companyId }, data: { matchedId: null } });
  await prisma.accountTransaction.update({ where: { id: entry.id }, data: { reconciledAt: d.reconciled ? new Date() : null, reconciledById: d.reconciled ? req.auth!.userId : null } });
  await audit(prisma, { ...auditCtx(req), action: 'reconciliation.mark', entityType: 'AccountTransaction', entityId: entry.id, summary: `Marked a book entry as ${d.reconciled ? 'reconciled' : 'unreconciled'}` });
  res.json({ data: { ok: true } });
}));

accountsRouter.get('/:id/reconciled', requirePerm('accounts.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const rows = await prisma.accountTransaction.findMany({
    where: { companyId, accountId: req.params.id, NOT: { reconciledAt: null } },
    include: { transaction: { select: { number: true, description: true } }, statementLine: { select: { description: true, date: true } } },
    orderBy: { reconciledAt: 'desc' }, take: 100,
  });
  res.json({ data: rows.map((b) => ({ id: b.id, date: fmtDate(b.date), direction: b.direction, amount: money(b.amount), number: b.transaction.number, description: b.transaction.description, statement: b.statementLine?.description ?? null, reconciledAt: b.reconciledAt })) });
}));

export const _zDate = zDate;
