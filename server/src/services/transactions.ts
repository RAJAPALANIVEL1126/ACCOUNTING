import type { Account, PaymentMethod, Transaction, TransactionType } from '@prisma/client';
import { Tx } from '../db';
import { AppError, forbidden, notFound, unprocessable } from '../lib/errors';
import { D, Dec, ZERO } from '../lib/money';
import { nextSequence, pad } from '../lib/sequence';
import { parseDate, today } from '../lib/dates';
import { audit } from '../lib/audit';
import { LineInput, mirrorLines, postJournal, systemAccount } from './ledger';
import { SYSTEM_CATEGORY } from './reference';
import { applyAllocation } from './allocations';

export interface Actor {
  userId: string;
  userName?: string | null;
  companyId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export const ONLINE_METHODS: PaymentMethod[] = ['UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'PAYMENT_GATEWAY', 'BANK_TRANSFER'];

export async function companyCurrency(tx: Tx, companyId: string) {
  const c = await tx.company.findUnique({ where: { id: companyId }, select: { baseCurrency: true } });
  if (!c) throw notFound('Company');
  return c.baseCurrency;
}

export async function moneyAccount(tx: Tx, companyId: string, id: string): Promise<Account> {
  const a = await tx.account.findFirst({ where: { id, companyId, subtype: { in: ['CASH', 'BANK'] } } });
  if (!a) throw new AppError(400, 'VALIDATION_ERROR', 'Select a valid cash or bank account', { fields: { accountId: 'Select a valid cash or bank account' } });
  if (!a.isActive) throw unprocessable(`Account "${a.name}" is inactive`);
  return a;
}

/** Cash payments use cash accounts; every other payment method settles through a bank account. */
export function assertMethodMatchesAccount(method: PaymentMethod, account: Account) {
  if (method === 'CREDIT') throw unprocessable('"On credit" is not a settlement method');
  if (method === 'CASH' && account.subtype !== 'CASH') throw unprocessable('Cash payments must use a cash account', 'METHOD_ACCOUNT_MISMATCH');
  if (method !== 'CASH' && method !== 'OTHER' && account.subtype !== 'BANK') {
    throw unprocessable('Non-cash payment methods must use a bank account', 'METHOD_ACCOUNT_MISMATCH');
  }
}

export async function categoryOf(tx: Tx, companyId: string, id: string, type: 'INCOME' | 'EXPENSE') {
  const c = await tx.transactionCategory.findFirst({ where: { id, companyId, type } });
  if (!c) throw new AppError(400, 'VALIDATION_ERROR', `Select a valid ${type.toLowerCase()} category`, { fields: { categoryId: 'Select a valid category' } });
  if (!c.isActive) throw unprocessable(`Category "${c.name}" is inactive`);
  return c;
}

export async function systemCategory(tx: Tx, companyId: string, name: string) {
  const c = await tx.transactionCategory.findFirst({ where: { companyId, name, isSystem: true } });
  if (!c) throw new AppError(500, 'CONFIG_ERROR', `System category "${name}" is missing`);
  return c;
}

async function assertParty(tx: Tx, companyId: string, kind: 'customer' | 'supplier', id?: string | null) {
  if (!id) return;
  const found = kind === 'customer' ? await tx.customer.findFirst({ where: { id, companyId } }) : await tx.supplier.findFirst({ where: { id, companyId } });
  if (!found) throw new AppError(400, 'VALIDATION_ERROR', `Select a valid ${kind}`, { fields: { [`${kind}Id`]: `Select a valid ${kind}` } });
}

async function assertAttachment(tx: Tx, companyId: string, id?: string | null) {
  if (!id) return;
  const a = await tx.attachment.findFirst({ where: { id, companyId } });
  if (!a) throw new AppError(400, 'VALIDATION_ERROR', 'Attachment not found');
}

type NewTxn = Omit<Parameters<Tx['transaction']['create']>[0]['data'], 'number' | 'companyId' | 'currency' | 'createdById'> & { type: TransactionType };

export async function insertTransaction(tx: Tx, actor: Actor, data: NewTxn): Promise<Transaction> {
  const number = 'TXN-' + pad(await nextSequence(tx, actor.companyId, 'TXN'));
  const currency = await companyCurrency(tx, actor.companyId);
  return tx.transaction.create({ data: { ...(data as object), number, companyId: actor.companyId, currency, createdById: actor.userId } as never });
}

// ───────────────────────── Income ─────────────────────────

export interface IncomeInput {
  date: string;
  categoryId: string;
  customerId?: string;
  description?: string;
  amount: Dec;
  taxAmount: Dec;
  paymentMethod: PaymentMethod;
  accountId: string;
  reference?: string;
  attachmentId?: string;
}

export async function createIncome(tx: Tx, actor: Actor, input: IncomeInput) {
  const account = await moneyAccount(tx, actor.companyId, input.accountId);
  assertMethodMatchesAccount(input.paymentMethod, account);
  const category = await categoryOf(tx, actor.companyId, input.categoryId, 'INCOME');
  await assertParty(tx, actor.companyId, 'customer', input.customerId);
  await assertAttachment(tx, actor.companyId, input.attachmentId);
  const total = input.amount.plus(input.taxAmount);

  const txn = await insertTransaction(tx, actor, {
    type: 'INCOME',
    status: 'POSTED',
    date: parseDate(input.date),
    amount: input.amount,
    taxAmount: input.taxAmount,
    totalAmount: total,
    categoryId: category.id,
    paymentMethod: input.paymentMethod,
    destinationAccountId: account.id,
    customerId: input.customerId ?? null,
    reference: input.reference ?? null,
    description: input.description ?? null,
    attachmentId: input.attachmentId ?? null,
  });
  const revenue = await systemAccount(tx, actor.companyId, 'REVENUE');
  const taxOut = await systemAccount(tx, actor.companyId, 'TAX_OUTPUT');
  await postJournal(tx, {
    companyId: actor.companyId,
    date: txn.date,
    description: `Income ${txn.number}${input.description ? ' — ' + input.description : ''}`,
    transactionId: txn.id,
    createdById: actor.userId,
    paymentMethod: input.paymentMethod,
    lines: [
      { accountId: account.id, debit: total },
      { accountId: revenue.id, credit: input.amount, categoryId: category.id, customerId: input.customerId },
      { accountId: taxOut.id, credit: input.taxAmount },
    ],
  });
  await audit(tx, { ...actor, action: 'transaction.create', entityType: 'Transaction', entityId: txn.id, summary: `Recorded income ${txn.number} of ${total.toFixed(2)} (${category.name})` });
  return txn;
}

// ───────────────────────── Expenses ─────────────────────────

export interface ExpenseInput {
  date: string;
  categoryId: string;
  supplierId?: string;
  description?: string;
  amount: Dec;
  taxAmount: Dec;
  taxRecoverable: boolean;
  paymentMethod: PaymentMethod;
  accountId?: string;
  reference?: string;
  attachmentId?: string;
  dueDate?: string;
}

async function expenseLines(tx: Tx, txn: Transaction): Promise<LineInput[]> {
  const expenses = await systemAccount(tx, txn.companyId, 'EXPENSE');
  const recoverable = txn.taxRecoverable ? txn.taxAmount : ZERO;
  const cost = txn.totalAmount.minus(recoverable);
  const lines: LineInput[] = [{ accountId: expenses.id, debit: cost, categoryId: txn.categoryId, supplierId: txn.supplierId }];
  if (recoverable.gt(0)) lines.push({ accountId: (await systemAccount(tx, txn.companyId, 'TAX_INPUT')).id, debit: recoverable });
  if (txn.onCredit) {
    lines.push({ accountId: (await systemAccount(tx, txn.companyId, 'PAYABLE')).id, credit: txn.totalAmount, supplierId: txn.supplierId });
  } else {
    lines.push({ accountId: txn.sourceAccountId!, credit: txn.totalAmount });
  }
  return lines;
}

async function postExpense(tx: Tx, actor: Actor, txn: Transaction) {
  await postJournal(tx, {
    companyId: txn.companyId,
    date: txn.date,
    description: `Expense ${txn.number}${txn.description ? ' — ' + txn.description : ''}`,
    transactionId: txn.id,
    createdById: actor.userId,
    paymentMethod: txn.paymentMethod,
    lines: await expenseLines(tx, txn),
  });
}

export async function createExpense(tx: Tx, actor: Actor, input: ExpenseInput) {
  const onCredit = input.paymentMethod === 'CREDIT';
  const category = await categoryOf(tx, actor.companyId, input.categoryId, 'EXPENSE');
  await assertParty(tx, actor.companyId, 'supplier', input.supplierId);
  await assertAttachment(tx, actor.companyId, input.attachmentId);
  let accountId: string | null = null;
  if (onCredit) {
    if (!input.supplierId) throw new AppError(400, 'VALIDATION_ERROR', 'A supplier is required for expenses on credit', { fields: { supplierId: 'Required for expenses on credit' } });
  } else {
    if (!input.accountId) throw new AppError(400, 'VALIDATION_ERROR', 'Select the account the expense was paid from', { fields: { accountId: 'Required' } });
    const account = await moneyAccount(tx, actor.companyId, input.accountId);
    assertMethodMatchesAccount(input.paymentMethod, account);
    accountId = account.id;
  }
  const settings = await tx.companySettings.findUnique({ where: { companyId: actor.companyId } });
  const needsApproval = Boolean(settings?.expenseApprovalRequired);
  const total = input.amount.plus(input.taxAmount);

  const txn = await insertTransaction(tx, actor, {
    type: 'EXPENSE',
    status: needsApproval ? 'PENDING_APPROVAL' : 'POSTED',
    date: parseDate(input.date),
    amount: input.amount,
    taxAmount: input.taxAmount,
    totalAmount: total,
    taxRecoverable: input.taxRecoverable && input.taxAmount.gt(0),
    categoryId: category.id,
    paymentMethod: input.paymentMethod,
    sourceAccountId: accountId,
    supplierId: input.supplierId ?? null,
    reference: input.reference ?? null,
    description: input.description ?? null,
    attachmentId: input.attachmentId ?? null,
    onCredit,
    dueDate: input.dueDate ? parseDate(input.dueDate) : null,
  });
  await tx.expense.create({ data: { companyId: actor.companyId, transactionId: txn.id, approvalStatus: needsApproval ? 'PENDING' : 'NOT_REQUIRED' } });
  if (!needsApproval) await postExpense(tx, actor, txn);
  await audit(tx, {
    ...actor,
    action: 'transaction.create',
    entityType: 'Transaction',
    entityId: txn.id,
    summary: `Recorded expense ${txn.number} of ${total.toFixed(2)} (${category.name})${needsApproval ? ' — awaiting approval' : ''}`,
  });
  return txn;
}

async function lockTransaction(tx: Tx, companyId: string, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Transaction" WHERE "id" = ${id} AND "companyId" = ${companyId} FOR UPDATE`;
  if (!rows.length) throw notFound('Transaction');
  return tx.transaction.findUniqueOrThrow({ where: { id }, include: { expense: true } });
}

export async function approveExpense(tx: Tx, actor: Actor, id: string) {
  const txn = await lockTransaction(tx, actor.companyId, id);
  if (txn.type !== 'EXPENSE' || txn.status !== 'PENDING_APPROVAL') throw unprocessable('Only expenses awaiting approval can be approved', 'INVALID_STATE');
  const settings = await tx.companySettings.findUnique({ where: { companyId: actor.companyId } });
  if (txn.createdById === actor.userId && !settings?.allowSelfApproval) {
    throw forbidden('Company policy requires an independent approver: you cannot approve an expense you recorded');
  }
  const updated = await tx.transaction.update({ where: { id }, data: { status: 'POSTED' } });
  await tx.expense.update({ where: { transactionId: id }, data: { approvalStatus: 'APPROVED', approvedById: actor.userId, approvedAt: new Date() } });
  await postExpense(tx, actor, updated);
  await audit(tx, { ...actor, action: 'expense.approve', entityType: 'Transaction', entityId: id, summary: `Approved expense ${txn.number} of ${txn.totalAmount.toFixed(2)}` });
  return updated;
}

export async function rejectExpense(tx: Tx, actor: Actor, id: string, reason: string) {
  const txn = await lockTransaction(tx, actor.companyId, id);
  if (txn.type !== 'EXPENSE' || txn.status !== 'PENDING_APPROVAL') throw unprocessable('Only expenses awaiting approval can be rejected', 'INVALID_STATE');
  const updated = await tx.transaction.update({ where: { id }, data: { status: 'REJECTED', reason } });
  await tx.expense.update({ where: { transactionId: id }, data: { approvalStatus: 'REJECTED', approvedById: actor.userId, approvedAt: new Date(), rejectionReason: reason } });
  await audit(tx, { ...actor, action: 'expense.reject', entityType: 'Transaction', entityId: id, summary: `Rejected expense ${txn.number}: ${reason}` });
  return updated;
}

// ───────────────────────── Transfers & adjustments ─────────────────────────

export interface TransferInput {
  date: string;
  fromAccountId: string;
  toAccountId: string;
  amount: Dec;
  description?: string;
  reference?: string;
}

export async function createTransfer(tx: Tx, actor: Actor, input: TransferInput) {
  if (input.fromAccountId === input.toAccountId) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Choose two different accounts', { fields: { toAccountId: 'Must differ from the source account' } });
  }
  const from = await moneyAccount(tx, actor.companyId, input.fromAccountId);
  const to = await moneyAccount(tx, actor.companyId, input.toAccountId);
  const method: PaymentMethod = from.subtype === 'CASH' || to.subtype === 'CASH' ? 'CASH' : 'BANK_TRANSFER';
  const txn = await insertTransaction(tx, actor, {
    type: 'TRANSFER',
    status: 'POSTED',
    date: parseDate(input.date),
    amount: input.amount,
    totalAmount: input.amount,
    paymentMethod: method,
    sourceAccountId: from.id,
    destinationAccountId: to.id,
    reference: input.reference ?? null,
    description: input.description ?? `Transfer from ${from.name} to ${to.name}`,
  });
  await postJournal(tx, {
    companyId: actor.companyId,
    date: txn.date,
    description: `Transfer ${txn.number}: ${from.name} → ${to.name}`,
    transactionId: txn.id,
    createdById: actor.userId,
    paymentMethod: method,
    isTransfer: true,
    lines: [
      { accountId: to.id, debit: input.amount },
      { accountId: from.id, credit: input.amount },
    ],
  });
  await audit(tx, { ...actor, action: 'transaction.create', entityType: 'Transaction', entityId: txn.id, summary: `Transferred ${input.amount.toFixed(2)} from ${from.name} to ${to.name} (${txn.number})` });
  return txn;
}

export interface AdjustmentInput {
  date: string;
  accountId: string;
  direction: 'INCREASE' | 'DECREASE';
  amount: Dec;
  reason: string;
  reference?: string;
}

/** Balances are never edited directly: an adjustment is a real, audited journal entry with a mandatory reason. */
export async function createAdjustment(tx: Tx, actor: Actor, input: AdjustmentInput) {
  const account = await moneyAccount(tx, actor.companyId, input.accountId);
  const increase = input.direction === 'INCREASE';
  const category = await systemCategory(tx, actor.companyId, increase ? SYSTEM_CATEGORY.ADJ_GAIN : SYSTEM_CATEGORY.ADJ_LOSS);
  const contra = await systemAccount(tx, actor.companyId, increase ? 'REVENUE' : 'EXPENSE');
  const txn = await insertTransaction(tx, actor, {
    type: 'ADJUSTMENT',
    status: 'POSTED',
    date: parseDate(input.date),
    amount: input.amount,
    totalAmount: input.amount,
    categoryId: category.id,
    paymentMethod: account.subtype === 'CASH' ? 'CASH' : 'OTHER',
    sourceAccountId: increase ? null : account.id,
    destinationAccountId: increase ? account.id : null,
    reference: input.reference ?? null,
    description: `${increase ? 'Increase' : 'Decrease'} adjustment — ${account.name}`,
    reason: input.reason,
  });
  await postJournal(tx, {
    companyId: actor.companyId,
    date: txn.date,
    description: `Adjustment ${txn.number}: ${input.reason}`,
    transactionId: txn.id,
    createdById: actor.userId,
    paymentMethod: txn.paymentMethod,
    lines: increase
      ? [{ accountId: account.id, debit: input.amount }, { accountId: contra.id, credit: input.amount, categoryId: category.id }]
      : [{ accountId: contra.id, debit: input.amount, categoryId: category.id }, { accountId: account.id, credit: input.amount }],
  });
  await audit(tx, {
    ...actor,
    action: 'adjustment.create',
    entityType: 'Transaction',
    entityId: txn.id,
    summary: `${increase ? 'Increased' : 'Decreased'} ${account.name} by ${input.amount.toFixed(2)} (${txn.number}). Reason: ${input.reason}`,
  });
  return txn;
}

export async function createOpeningBalance(tx: Tx, actor: Actor, account: Account, amount: Dec, date: Date) {
  if (amount.lte(0)) return null;
  const equity = await systemAccount(tx, actor.companyId, 'OPENING_EQUITY');
  const txn = await insertTransaction(tx, actor, {
    type: 'OPENING_BALANCE',
    status: 'POSTED',
    date,
    amount,
    totalAmount: amount,
    paymentMethod: account.subtype === 'CASH' ? 'CASH' : 'OTHER',
    destinationAccountId: account.id,
    description: `Opening balance — ${account.name}`,
  });
  await postJournal(tx, {
    companyId: actor.companyId,
    date,
    description: `Opening balance — ${account.name}`,
    transactionId: txn.id,
    createdById: actor.userId,
    paymentMethod: txn.paymentMethod,
    lines: [{ accountId: account.id, debit: amount }, { accountId: equity.id, credit: amount }],
  });
  return txn;
}

// ───────────────────────── Reversal ─────────────────────────

/**
 * Finalised transactions are never deleted or edited in place. A reversal posts the exact
 * mirror image of the original journal, links both records, and releases any allocations.
 */
export async function reverseTransaction(tx: Tx, actor: Actor, id: string, reason: string, date?: string) {
  const txn = await lockTransaction(tx, actor.companyId, id);
  if (txn.isReversal) throw unprocessable('A reversal entry cannot itself be reversed', 'INVALID_STATE');
  if (txn.status === 'REVERSED') throw unprocessable('This transaction has already been reversed', 'ALREADY_REVERSED');
  if (txn.status !== 'POSTED') throw unprocessable('Only posted transactions can be reversed', 'INVALID_STATE');
  if (txn.type === 'REFUND') throw unprocessable('Refunds cannot be reversed. Record a new payment instead.', 'INVALID_STATE');
  if (txn.onCredit && txn.amountPaid.gt(0)) throw unprocessable('Reverse the supplier payments made against this bill first', 'HAS_PAYMENTS');

  const payment = await tx.payment.findFirst({ where: { transactionId: id, companyId: actor.companyId } });
  if (payment && payment.refundedAmount.gt(0)) throw unprocessable('This payment has refunds and cannot be reversed', 'HAS_REFUNDS');

  const reversalDate = parseDate(date ?? today());
  if (reversalDate < txn.date) throw unprocessable('The reversal date cannot be earlier than the original transaction date');

  const entries = await tx.journalEntry.findMany({ where: { transactionId: id }, include: { lines: true } });
  const reversal = await insertTransaction(tx, actor, {
    type: txn.type,
    status: 'POSTED',
    date: reversalDate,
    amount: txn.amount,
    taxAmount: txn.taxAmount,
    totalAmount: txn.totalAmount,
    taxRecoverable: txn.taxRecoverable,
    categoryId: txn.categoryId,
    paymentMethod: txn.paymentMethod,
    sourceAccountId: txn.destinationAccountId,
    destinationAccountId: txn.sourceAccountId,
    customerId: txn.customerId,
    supplierId: txn.supplierId,
    invoiceId: txn.invoiceId,
    reference: txn.reference,
    description: `Reversal of ${txn.number}`,
    reason,
    onCredit: txn.onCredit,
    isReversal: true,
    reversalOfId: txn.id,
  });
  for (const e of entries) {
    await postJournal(tx, {
      companyId: actor.companyId,
      date: reversalDate,
      description: `Reversal of ${txn.number}: ${reason}`,
      transactionId: reversal.id,
      isReversal: true,
      createdById: actor.userId,
      paymentMethod: txn.paymentMethod,
      isTransfer: txn.type === 'TRANSFER',
      lines: mirrorLines(e.lines),
    });
  }
  // Release whatever this transaction had settled.
  const allocations = await tx.paymentAllocation.findMany({ where: { transactionId: id, companyId: actor.companyId } });
  for (const a of allocations) {
    await applyAllocation(tx, {
      companyId: actor.companyId,
      paymentId: a.paymentId,
      transactionId: reversal.id,
      invoiceId: a.invoiceId,
      billTransactionId: a.billTransactionId,
      amount: a.amount.negated(),
      date: reversalDate,
    });
  }
  if (payment) {
    await tx.payment.update({ where: { id: payment.id }, data: { status: 'REVERSED' } });
    await audit(tx, { ...actor, action: 'payment.status', entityType: 'Payment', entityId: payment.id, summary: `Payment ${payment.number} marked REVERSED (transaction ${txn.number} reversed)` });
  }
  await tx.transaction.update({ where: { id }, data: { status: 'REVERSED' } });
  await audit(tx, {
    ...actor,
    action: 'transaction.reverse',
    entityType: 'Transaction',
    entityId: id,
    summary: `Reversed ${txn.number} (${txn.totalAmount.toFixed(2)}) with ${reversal.number}. Reason: ${reason}`,
    metadata: { reversalId: reversal.id },
  });
  return reversal;
}

export const dec = D;
