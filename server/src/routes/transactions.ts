import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Prisma as P } from '@prisma/client';
import { prisma } from '../db';
import { parse, zDate, zDateOptional, zId, zIdOptional, zMoneyOptional, zMoneyPositive, zPage, zText } from '../lib/validate';
import { AppError, forbidden, notFound, unprocessable } from '../lib/errors';
import { audit, auditCtx, diff } from '../lib/audit';
import { money, sum } from '../lib/money';
import { fmtDate, parseDate, today } from '../lib/dates';
import { sendMail } from '../lib/mailer';
import { can, companyOf, h, requirePerm } from '../middleware/auth';
import { idempotent } from '../middleware/idempotency';
import {
  approveExpense, createAdjustment, createExpense, createIncome, createTransfer, rejectExpense, reverseTransaction,
} from '../services/transactions';
import { recordPayment } from '../services/payments';
import { accountingMethodOf } from '../services/finance';
import { sendReport } from '../services/exporter';
import type { Report } from '../services/reports';
import { actorOf, inTx, userNames } from './helpers';

export const transactionsRouter = Router();
export const incomeRouter = Router();
export const expensesRouter = Router();

const METHODS = ['CASH', 'BANK_TRANSFER', 'UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'PAYMENT_GATEWAY', 'CHEQUE', 'CREDIT', 'OTHER'] as const;
const SETTLEMENT_METHODS = METHODS.filter((m) => m !== 'CREDIT') as unknown as [string, ...string[]];
const TYPES = ['INCOME', 'EXPENSE', 'TRANSFER', 'ADJUSTMENT', 'RECEIPT', 'SUPPLIER_PAYMENT', 'REFUND', 'OPENING_BALANCE'] as const;
const STATUSES = ['PENDING_APPROVAL', 'POSTED', 'REJECTED', 'REVERSED'] as const;

const incomeSchema = z.object({
  date: zDate,
  categoryId: zId,
  customerId: zIdOptional,
  description: zText(500),
  amount: zMoneyPositive,
  taxAmount: zMoneyOptional,
  paymentMethod: z.enum(SETTLEMENT_METHODS, { errorMap: () => ({ message: 'Select a payment method' }) }),
  accountId: zId,
  reference: zText(100),
  attachmentId: zIdOptional,
});

const expenseSchema = z.object({
  date: zDate,
  categoryId: zId,
  supplierId: zIdOptional,
  description: zText(500),
  amount: zMoneyPositive,
  taxAmount: zMoneyOptional,
  taxRecoverable: z.boolean().default(false),
  paymentMethod: z.enum(METHODS, { errorMap: () => ({ message: 'Select a payment method' }) }),
  accountId: zIdOptional,
  reference: zText(100),
  attachmentId: zIdOptional,
  dueDate: zDateOptional,
});

const transferSchema = z.object({ date: zDate, fromAccountId: zId, toAccountId: zId, amount: zMoneyPositive, description: zText(500), reference: zText(100) });
const adjustmentSchema = z.object({
  date: zDate,
  accountId: zId,
  direction: z.enum(['INCREASE', 'DECREASE'], { errorMap: () => ({ message: 'Choose increase or decrease' }) }),
  amount: zMoneyPositive,
  reason: z.string({ required_error: 'A reason is required' }).trim().min(5, 'Explain the reason for this adjustment (at least 5 characters)').max(500),
  reference: zText(100),
});

function assertNotFuture(date: string) {
  if (date > today()) throw new AppError(400, 'VALIDATION_ERROR', 'The date cannot be in the future', { fields: { date: 'Cannot be in the future' } });
}

async function notifyApprovers(companyId: string, number: string, total: string, by: string) {
  const settings = await prisma.companySettings.findUnique({ where: { companyId } });
  if (!settings?.notifyExpenseApproval) return;
  const approvers = await prisma.user.findMany({ where: { companyId, status: 'ACTIVE', role: { name: { in: ['SUPER_ADMIN', 'ADMIN'] } } }, select: { email: true } });
  await Promise.all(approvers.map((u) => sendMail({ to: u.email, subject: `Expense ${number} needs approval`, text: `${by} recorded expense ${number} for ${total}. Sign in to review and approve or reject it.` })));
}

async function create(req: Request, res: Response, forcedType?: 'INCOME' | 'EXPENSE') {
  const type = forcedType ?? parse(z.object({ type: z.enum(['INCOME', 'EXPENSE', 'TRANSFER', 'ADJUSTMENT'], { errorMap: () => ({ message: 'type must be INCOME, EXPENSE, TRANSFER or ADJUSTMENT' }) }) }), req.body).type;
  const actor = actorOf(req);
  let txn;
  if (type === 'INCOME') {
    const d = parse(incomeSchema, req.body);
    assertNotFuture(d.date);
    txn = await inTx((tx) => createIncome(tx, actor, d as never));
  } else if (type === 'EXPENSE') {
    const d = parse(expenseSchema, req.body);
    assertNotFuture(d.date);
    txn = await inTx((tx) => createExpense(tx, actor, d as never));
    if (txn.status === 'PENDING_APPROVAL') notifyApprovers(actor.companyId, txn.number, money(txn.totalAmount), actor.userName ?? 'A user').catch(() => undefined);
  } else if (type === 'TRANSFER') {
    const d = parse(transferSchema, req.body);
    assertNotFuture(d.date);
    txn = await inTx((tx) => createTransfer(tx, actor, d));
  } else {
    if (!can(req, 'adjustments.create')) throw forbidden('Only administrators can post balance adjustments');
    const d = parse(adjustmentSchema, req.body);
    assertNotFuture(d.date);
    txn = await inTx((tx) => createAdjustment(tx, actor, d));
  }
  res.status(201).json({ data: txn });
}

const listSchema = zPage.extend({
  from: zDateOptional,
  to: zDateOptional,
  type: z.enum(TYPES).optional(),
  status: z.enum(STATUSES).optional(),
  paymentMethod: z.enum(METHODS).optional(),
  accountId: zIdOptional,
  categoryId: zIdOptional,
  customerId: zIdOptional,
  supplierId: zIdOptional,
  approval: z.enum(['PENDING']).optional(),
  unpaid: z.string().optional(),
  q: zText(100),
  sort: z.enum(['date', 'amount', 'number', 'createdAt']).default('date'),
  order: z.enum(['asc', 'desc']).default('desc'),
  format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json'),
});

async function list(req: Request, res: Response, forcedType?: 'INCOME' | 'EXPENSE') {
  const companyId = companyOf(req);
  const q = parse(listSchema, req.query);
  const where: P.TransactionWhereInput = { companyId };
  if (forcedType) where.type = forcedType;
  else if (q.type) where.type = q.type;
  if (q.status) where.status = q.status;
  if (q.approval) where.status = 'PENDING_APPROVAL';
  if (q.paymentMethod) where.paymentMethod = q.paymentMethod;
  if (q.categoryId) where.categoryId = q.categoryId;
  if (q.customerId) where.customerId = q.customerId;
  if (q.supplierId) where.supplierId = q.supplierId;
  if (q.unpaid) Object.assign(where, { onCredit: true, status: 'POSTED', isReversal: false });
  if (q.from || q.to) where.date = { ...(q.from ? { gte: parseDate(q.from) } : {}), ...(q.to ? { lte: parseDate(q.to) } : {}) };
  const and: P.TransactionWhereInput[] = [];
  if (q.accountId) and.push({ OR: [{ sourceAccountId: q.accountId }, { destinationAccountId: q.accountId }] });
  if (q.q) {
    const c = { contains: q.q, mode: 'insensitive' as const };
    and.push({ OR: [{ number: c }, { description: c }, { reference: c }, { customer: { name: c } }, { supplier: { name: c } }] });
  }
  if (and.length) where.AND = and;

  const sortField = q.sort === 'amount' ? 'totalAmount' : q.sort;
  const exporting = q.format !== 'json';
  if (exporting && !can(req, 'reports.export')) throw forbidden('You do not have permission to export data');
  const [rows, total, agg] = await Promise.all([
    prisma.transaction.findMany({
      where,
      include: { category: { select: { name: true } }, customer: { select: { name: true } }, supplier: { select: { name: true } }, expense: { select: { approvalStatus: true } } },
      orderBy: [{ [sortField]: q.order }, { createdAt: q.order }],
      skip: exporting ? 0 : (q.page - 1) * q.pageSize,
      take: exporting ? 20000 : q.pageSize,
    }),
    prisma.transaction.count({ where }),
    prisma.transaction.aggregate({ where: { ...where, status: 'POSTED', isReversal: false }, _sum: { totalAmount: true, amount: true, taxAmount: true } }),
  ]);
  const accountIds = [...new Set(rows.flatMap((r) => [r.sourceAccountId, r.destinationAccountId]).filter((x): x is string => Boolean(x)))];
  const accounts = new Map((await prisma.account.findMany({ where: { companyId, id: { in: accountIds } }, select: { id: true, name: true } })).map((a) => [a.id, a.name]));
  const names = await userNames(rows.map((r) => r.createdById));
  const data = rows.map((r) => ({
    id: r.id, number: r.number, type: r.type, status: r.status, date: fmtDate(r.date), amount: money(r.amount), taxAmount: money(r.taxAmount), totalAmount: money(r.totalAmount),
    currency: r.currency, category: r.category?.name ?? null, categoryId: r.categoryId, paymentMethod: r.paymentMethod,
    sourceAccount: r.sourceAccountId ? accounts.get(r.sourceAccountId) ?? null : null, destinationAccount: r.destinationAccountId ? accounts.get(r.destinationAccountId) ?? null : null,
    customer: r.customer?.name ?? null, supplier: r.supplier?.name ?? null, supplierId: r.supplierId, reference: r.reference, description: r.description,
    isReversal: r.isReversal, onCredit: r.onCredit, amountPaid: money(r.amountPaid), outstanding: money(r.onCredit ? r.totalAmount.minus(r.amountPaid) : 0),
    dueDate: r.dueDate ? fmtDate(r.dueDate) : null, approvalStatus: r.expense?.approvalStatus ?? null, hasAttachment: Boolean(r.attachmentId),
    createdBy: names.get(r.createdById) ?? null, createdById: r.createdById, createdAt: r.createdAt, updatedAt: r.updatedAt,
  }));

  if (exporting) {
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
    const method = await accountingMethodOf(companyId);
    const report: Report = {
      key: forcedType ? forcedType.toLowerCase() + '-transactions' : 'transactions',
      title: forcedType === 'INCOME' ? 'Income Transactions' : forcedType === 'EXPENSE' ? 'Expense Transactions' : 'Transactions',
      note: 'Totals include posted, non-reversal transactions only.',
      columns: [
        { key: 'number', label: 'Transaction ID' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'type', label: 'Type' }, { key: 'category', label: 'Category' },
        { key: 'party', label: 'Customer / Supplier' }, { key: 'description', label: 'Description' }, { key: 'paymentMethod', label: 'Payment Method' },
        { key: 'account', label: 'Account' }, { key: 'reference', label: 'Reference' }, { key: 'amount', label: 'Amount', type: 'money' },
        { key: 'taxAmount', label: 'Tax', type: 'money' }, { key: 'totalAmount', label: 'Total', type: 'money' }, { key: 'status', label: 'Status' }, { key: 'createdBy', label: 'Created By' },
      ],
      rows: data.map((r) => ({ ...r, party: r.customer ?? r.supplier ?? '', account: [r.sourceAccount, r.destinationAccount].filter(Boolean).join(' → '), category: r.category ?? '', description: r.description ?? '', reference: r.reference ?? '', status: r.isReversal ? 'REVERSAL' : r.status, createdBy: r.createdBy ?? '' })),
      totals: { number: 'Total (posted)', amount: money(agg._sum.amount), taxAmount: money(agg._sum.taxAmount), totalAmount: money(agg._sum.totalAmount) },
      meta: { companyName: company.name, currency: company.baseCurrency, from: q.from ?? 'beginning', to: q.to ?? today(), generatedAt: new Date().toISOString(), accountingMethod: method, basis: 'Transaction register', filters: Object.fromEntries(Object.entries({ type: forcedType ?? q.type, status: q.status, paymentMethod: q.paymentMethod, search: q.q }).filter(([, v]) => v).map(([k, v]) => [k, String(v)])) },
    };
    await audit(prisma, { ...auditCtx(req), action: 'export', entityType: 'Transaction', summary: `Exported ${data.length} transaction(s) as ${q.format.toUpperCase()}` });
    return sendReport(res, report, q.format);
  }
  res.json({ data, meta: { page: q.page, pageSize: q.pageSize, total, totals: { amount: money(agg._sum.amount), taxAmount: money(agg._sum.taxAmount), totalAmount: money(agg._sum.totalAmount) } } });
}

transactionsRouter.get('/', requirePerm('transactions.view'), h((req, res) => list(req, res)));
transactionsRouter.post('/', requirePerm('transactions.create'), idempotent, h((req, res) => create(req, res)));
incomeRouter.get('/', requirePerm('transactions.view'), h((req, res) => list(req, res, 'INCOME')));
incomeRouter.post('/', requirePerm('transactions.create'), idempotent, h((req, res) => create(req, res, 'INCOME')));
expensesRouter.get('/', requirePerm('transactions.view'), h((req, res) => list(req, res, 'EXPENSE')));
expensesRouter.post('/', requirePerm('transactions.create'), idempotent, h((req, res) => create(req, res, 'EXPENSE')));

// Pay a supplier bill (an expense recorded on credit).
expensesRouter.post('/:id/payments', requirePerm('payments.manage'), idempotent, h(async (req, res) => {
  const d = parse(z.object({ date: zDate, amount: zMoneyPositive, paymentMethod: z.enum(SETTLEMENT_METHODS, { errorMap: () => ({ message: 'Select a payment method' }) }), accountId: zId, reference: zText(100) }), req.body);
  assertNotFuture(d.date);
  const payment = await inTx((tx) => recordPayment(tx, actorOf(req), {
    direction: 'OUTBOUND', status: 'SUCCESS', method: d.paymentMethod as never, billTransactionId: req.params.id, accountId: d.accountId, date: d.date, amount: d.amount, fee: sum([]), reference: d.reference,
  }));
  res.status(201).json({ data: payment });
}));

transactionsRouter.get('/:id', requirePerm('transactions.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const t = await prisma.transaction.findFirst({
    where: { id: req.params.id, companyId },
    include: {
      category: true, customer: { select: { id: true, name: true } }, supplier: { select: { id: true, name: true } }, expense: true,
      reversalOf: { select: { id: true, number: true } }, reversedBy: { select: { id: true, number: true, date: true, reason: true } },
      journalEntries: { include: { lines: { include: { account: { select: { code: true, name: true } }, category: { select: { name: true } } } } }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!t) throw notFound('Transaction');
  const [accounts, names, history, attachment, invoice] = await Promise.all([
    prisma.account.findMany({ where: { companyId, id: { in: [t.sourceAccountId, t.destinationAccountId].filter((x): x is string => Boolean(x)) } }, select: { id: true, name: true } }),
    userNames([t.createdById, t.expense?.approvedById]),
    can(req, 'audit.view') || t.createdById === req.auth!.userId
      ? prisma.auditLog.findMany({ where: { companyId, entityType: 'Transaction', entityId: t.id }, orderBy: { createdAt: 'asc' }, select: { id: true, action: true, summary: true, userName: true, createdAt: true } })
      : Promise.resolve([]),
    t.attachmentId ? prisma.attachment.findFirst({ where: { id: t.attachmentId, companyId }, select: { id: true, fileName: true, mimeType: true, size: true } }) : null,
    t.invoiceId ? prisma.invoice.findFirst({ where: { id: t.invoiceId, companyId }, select: { id: true, number: true } }) : null,
  ]);
  const acc = new Map(accounts.map((a) => [a.id, a.name]));
  res.json({
    data: {
      id: t.id, number: t.number, companyId: t.companyId, type: t.type, status: t.status, date: fmtDate(t.date), amount: money(t.amount), taxAmount: money(t.taxAmount), totalAmount: money(t.totalAmount),
      taxRecoverable: t.taxRecoverable, currency: t.currency, category: t.category ? { id: t.category.id, name: t.category.name } : null, paymentMethod: t.paymentMethod,
      sourceAccount: t.sourceAccountId ? { id: t.sourceAccountId, name: acc.get(t.sourceAccountId) } : null,
      destinationAccount: t.destinationAccountId ? { id: t.destinationAccountId, name: acc.get(t.destinationAccountId) } : null,
      customer: t.customer, supplier: t.supplier, invoice, reference: t.reference, description: t.description, reason: t.reason,
      onCredit: t.onCredit, amountPaid: money(t.amountPaid), outstanding: money(t.onCredit ? t.totalAmount.minus(t.amountPaid) : 0), dueDate: t.dueDate ? fmtDate(t.dueDate) : null,
      isReversal: t.isReversal, reversalOf: t.reversalOf, reversedBy: t.reversedBy ? { ...t.reversedBy, date: fmtDate(t.reversedBy.date) } : null,
      approval: t.expense ? { status: t.expense.approvalStatus, approvedBy: t.expense.approvedById ? names.get(t.expense.approvedById) ?? null : null, approvedAt: t.expense.approvedAt, rejectionReason: t.expense.rejectionReason } : null,
      attachment, createdBy: names.get(t.createdById) ?? null, createdById: t.createdById, createdAt: t.createdAt, updatedAt: t.updatedAt,
      journal: t.journalEntries.map((e) => ({
        id: e.id, number: e.number, date: fmtDate(e.date), description: e.description, isReversal: e.isReversal,
        lines: e.lines.map((l) => ({ account: `${l.account.code} ${l.account.name}`, category: l.category?.name ?? null, debit: money(l.debit), credit: money(l.credit) })),
      })),
      history,
    },
  });
}));

// Posted transactions are immutable except for descriptive fields. Financial corrections = reverse and re-enter.
transactionsRouter.patch('/:id', requirePerm('transactions.create'), h(async (req, res) => {
  const companyId = companyOf(req);
  const t = await prisma.transaction.findFirst({ where: { id: req.params.id, companyId } });
  if (!t) throw notFound('Transaction');
  if (t.isReversal || ['REVERSED', 'REJECTED'].includes(t.status)) throw unprocessable('This transaction is final and cannot be edited', 'INVALID_STATE');
  const FINANCIAL = ['amount', 'taxAmount', 'date', 'categoryId', 'accountId', 'paymentMethod', 'supplierId', 'taxRecoverable'];

  if (t.status === 'POSTED') {
    const attempted = FINANCIAL.filter((k) => k in (req.body ?? {}));
    if (attempted.length) throw unprocessable('Posted transactions cannot be financially edited. Reverse the transaction and record a new one.', 'FINALIZED');
    const d = parse(z.object({ description: zText(500), reference: zText(100) }), req.body);
    const data = { description: 'description' in req.body ? d.description ?? null : t.description, reference: 'reference' in req.body ? d.reference ?? null : t.reference };
    const changes = diff(t as never, data);
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.transaction.update({ where: { id: t.id }, data });
      if (Object.keys(changes).length) await audit(tx, { ...auditCtx(req), action: 'transaction.update', entityType: 'Transaction', entityId: t.id, summary: `Edited ${t.number}: ${Object.keys(changes).join(', ')}`, metadata: { changes } });
      return u;
    });
    return res.json({ data: updated });
  }

  // PENDING_APPROVAL expense: nothing is in the ledger yet, so its creator (or an approver) may still correct it.
  if (t.createdById !== req.auth!.userId && !can(req, 'expenses.approve')) throw forbidden('Only the person who recorded this expense or an approver can edit it');
  const d = parse(z.object({ date: zDateOptional, categoryId: zIdOptional, amount: zMoneyPositive.optional(), taxAmount: zMoneyOptional.optional(), description: zText(500), reference: zText(100) }), req.body);
  if (d.date) assertNotFuture(d.date);
  if (d.categoryId && !(await prisma.transactionCategory.findFirst({ where: { id: d.categoryId, companyId, type: 'EXPENSE', isActive: true } }))) throw new AppError(400, 'VALIDATION_ERROR', 'Select a valid expense category', { fields: { categoryId: 'Select a valid category' } });
  const amount = d.amount ?? t.amount;
  const taxAmount = 'taxAmount' in req.body && d.taxAmount ? d.taxAmount : t.taxAmount;
  const data = {
    date: d.date ? parseDate(d.date) : t.date, categoryId: d.categoryId ?? t.categoryId, amount, taxAmount, totalAmount: amount.plus(taxAmount),
    description: 'description' in req.body ? d.description ?? null : t.description, reference: 'reference' in req.body ? d.reference ?? null : t.reference,
  };
  const changes = diff({ ...t, amount: money(t.amount), taxAmount: money(t.taxAmount), totalAmount: money(t.totalAmount) } as never, { ...data, amount: money(data.amount), taxAmount: money(data.taxAmount), totalAmount: money(data.totalAmount) });
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.transaction.update({ where: { id: t.id }, data });
    await audit(tx, { ...auditCtx(req), action: 'transaction.update', entityType: 'Transaction', entityId: t.id, summary: `Edited pending expense ${t.number}: ${Object.keys(changes).join(', ') || 'no changes'}`, metadata: { changes } });
    return u;
  });
  res.json({ data: updated });
}));

transactionsRouter.post('/:id/reverse', requirePerm('transactions.reverse'), idempotent, h(async (req, res) => {
  const d = parse(z.object({ reason: z.string({ required_error: 'A reason is required' }).trim().min(5, 'Explain why this transaction is being reversed (at least 5 characters)').max(500), date: zDateOptional }), req.body);
  if (d.date) assertNotFuture(d.date);
  const reversal = await inTx((tx) => reverseTransaction(tx, actorOf(req), req.params.id, d.reason, d.date));
  res.status(201).json({ data: reversal });
}));

transactionsRouter.post('/:id/approve', requirePerm('expenses.approve'), h(async (req, res) => {
  res.json({ data: await inTx((tx) => approveExpense(tx, actorOf(req), req.params.id)) });
}));

transactionsRouter.post('/:id/reject', requirePerm('expenses.approve'), h(async (req, res) => {
  const d = parse(z.object({ reason: z.string({ required_error: 'A reason is required' }).trim().min(5, 'Give a reason (at least 5 characters)').max(500) }), req.body);
  res.json({ data: await inTx((tx) => rejectExpense(tx, actorOf(req), req.params.id, d.reason)) });
}));
