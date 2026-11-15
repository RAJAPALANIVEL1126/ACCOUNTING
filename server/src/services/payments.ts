import type { Payment, PaymentDirection, PaymentMethod } from '@prisma/client';
import { Prisma, Tx } from '../db';
import { AppError, conflict, notFound, unprocessable } from '../lib/errors';
import { Dec, ZERO } from '../lib/money';
import { nextSequence, pad } from '../lib/sequence';
import { parseDate } from '../lib/dates';
import { audit } from '../lib/audit';
import { LineInput, postJournal, systemAccount } from './ledger';
import { Actor, assertMethodMatchesAccount, categoryOf, companyCurrency, insertTransaction, moneyAccount, systemCategory } from './transactions';
import { applyAllocation } from './allocations';
import { SYSTEM_CATEGORY } from './reference';

export interface PaymentInput {
  direction: PaymentDirection;
  status: 'SUCCESS' | 'PENDING';
  method: PaymentMethod;
  gateway?: string;
  gatewayPaymentId?: string;
  gatewayOrderId?: string;
  customerId?: string;
  supplierId?: string;
  invoiceId?: string;
  billTransactionId?: string;
  categoryId?: string;
  accountId: string;
  date: string;
  amount: Dec;
  fee: Dec;
  reference?: string;
  notes?: string;
}

async function lockPayment(tx: Tx, companyId: string, id: string): Promise<Payment> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Payment" WHERE "id" = ${id} AND "companyId" = ${companyId} FOR UPDATE`;
  if (!rows.length) throw notFound('Payment');
  return tx.payment.findUniqueOrThrow({ where: { id } });
}

/**
 * Records a payment. Money only reaches the ledger when the payment is SUCCESS:
 * a PENDING payment is a memo record until it is confirmed (manually in recording
 * mode, or by a verified gateway webhook).
 */
export async function recordPayment(tx: Tx, actor: Actor, input: PaymentInput): Promise<Payment> {
  const account = await moneyAccount(tx, actor.companyId, input.accountId);
  assertMethodMatchesAccount(input.method, account);
  if (input.fee.gt(input.amount)) throw new AppError(400, 'VALIDATION_ERROR', 'Fee cannot exceed the payment amount', { fields: { fee: 'Cannot exceed the amount' } });

  let customerId = input.customerId ?? null;
  let supplierId = input.supplierId ?? null;
  if (input.direction === 'INBOUND') {
    if (input.billTransactionId || input.supplierId) throw unprocessable('Inbound payments cannot reference a supplier or bill');
    if (input.invoiceId) {
      const inv = await tx.invoice.findFirst({ where: { id: input.invoiceId, companyId: actor.companyId } });
      if (!inv) throw notFound('Invoice');
      if (input.categoryId) throw unprocessable('An invoice payment cannot also carry an income category');
      customerId = inv.customerId;
    } else if (input.categoryId) {
      await categoryOf(tx, actor.companyId, input.categoryId, 'INCOME');
    } else if (!customerId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Link the payment to an invoice, a customer or an income category', { fields: { invoiceId: 'Select an invoice, customer or income category' } });
    }
    if (customerId && !(await tx.customer.findFirst({ where: { id: customerId, companyId: actor.companyId } }))) throw notFound('Customer');
  } else {
    if (input.invoiceId || input.customerId || input.categoryId) throw unprocessable('Outbound payments cannot reference a customer, invoice or income category');
    if (input.fee.gt(0)) throw unprocessable('Processing fees are only supported on inbound payments');
    if (input.billTransactionId) {
      const bill = await tx.transaction.findFirst({ where: { id: input.billTransactionId, companyId: actor.companyId, type: 'EXPENSE', onCredit: true } });
      if (!bill) throw notFound('Bill');
      supplierId = bill.supplierId;
    }
    if (!supplierId || !(await tx.supplier.findFirst({ where: { id: supplierId, companyId: actor.companyId } }))) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Select a supplier or a bill to pay', { fields: { supplierId: 'Required' } });
    }
  }

  const gateway = input.gateway?.trim().toLowerCase() || (input.gatewayPaymentId ? 'manual' : null);
  if (gateway && input.gatewayPaymentId) {
    const dup = await tx.payment.findFirst({ where: { companyId: actor.companyId, gateway, gatewayPaymentId: input.gatewayPaymentId } });
    if (dup) throw conflict(`A payment with reference ${input.gatewayPaymentId} is already recorded (${dup.number})`, 'DUPLICATE_PAYMENT');
  }

  const number = 'PAY-' + pad(await nextSequence(tx, actor.companyId, 'PAY'));
  let payment: Payment;
  try {
    payment = await tx.payment.create({
      data: {
        companyId: actor.companyId,
        number,
        direction: input.direction,
        status: 'PENDING',
        method: input.method,
        gateway,
        gatewayPaymentId: input.gatewayPaymentId ?? null,
        gatewayOrderId: input.gatewayOrderId ?? null,
        customerId,
        supplierId,
        invoiceId: input.invoiceId ?? null,
        billTransactionId: input.billTransactionId ?? null,
        categoryId: input.categoryId ?? null,
        accountId: account.id,
        date: parseDate(input.date),
        amount: input.amount,
        fee: input.fee,
        currency: await companyCurrency(tx, actor.companyId),
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        createdById: actor.userId,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('This payment reference is already recorded', 'DUPLICATE_PAYMENT');
    throw e;
  }
  await audit(tx, { ...actor, action: 'payment.create', entityType: 'Payment', entityId: payment.id, summary: `Recorded ${input.direction.toLowerCase()} payment ${number} of ${input.amount.toFixed(2)} via ${input.method} (${input.status})` });
  if (input.status === 'SUCCESS') payment = await settlePayment(tx, actor, payment.id);
  return payment;
}

/** Moves a PENDING payment to SUCCESS and posts it to the ledger exactly once. */
export async function settlePayment(tx: Tx, actor: Actor, paymentId: string, patch: { gatewayPaymentId?: string; method?: PaymentMethod; fee?: Dec; date?: Date } = {}): Promise<Payment> {
  let p = await lockPayment(tx, actor.companyId, paymentId);
  if (p.status === 'SUCCESS') return p; // idempotent
  if (p.status !== 'PENDING') throw unprocessable(`A ${p.status.toLowerCase()} payment cannot be completed`, 'INVALID_STATE');
  if (Object.keys(patch).length) {
    p = await tx.payment.update({
      where: { id: p.id },
      data: { gatewayPaymentId: patch.gatewayPaymentId ?? p.gatewayPaymentId, method: patch.method ?? p.method, fee: patch.fee ?? p.fee, date: patch.date ?? p.date },
    });
  }
  const inbound = p.direction === 'INBOUND';

  if (p.invoiceId) {
    await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${p.invoiceId} AND "companyId" = ${actor.companyId} FOR UPDATE`;
    const inv = await tx.invoice.findFirstOrThrow({ where: { id: p.invoiceId, companyId: actor.companyId } });
    if (!['ISSUED', 'PARTIALLY_PAID'].includes(inv.status)) throw unprocessable(`Invoice ${inv.number} is ${inv.status.toLowerCase().replace('_', ' ')} and cannot receive payments`, 'INVALID_STATE');
    const outstanding = inv.total.minus(inv.amountPaid);
    if (p.amount.gt(outstanding)) throw unprocessable(`Payment exceeds the outstanding balance of ${outstanding.toFixed(2)} on invoice ${inv.number}`, 'OVERPAYMENT');
    if (p.date < inv.issueDate) throw unprocessable('Payment date cannot be before the invoice date');
  }
  if (p.billTransactionId) {
    await tx.$queryRaw`SELECT "id" FROM "Transaction" WHERE "id" = ${p.billTransactionId} AND "companyId" = ${actor.companyId} FOR UPDATE`;
    const bill = await tx.transaction.findFirstOrThrow({ where: { id: p.billTransactionId, companyId: actor.companyId } });
    if (bill.status !== 'POSTED') throw unprocessable('Only posted bills can be paid', 'INVALID_STATE');
    const outstanding = bill.totalAmount.minus(bill.amountPaid);
    if (p.amount.gt(outstanding)) throw unprocessable(`Payment exceeds the outstanding balance of ${outstanding.toFixed(2)} on bill ${bill.number}`, 'OVERPAYMENT');
  }

  const lines: LineInput[] = [];
  let type: 'RECEIPT' | 'INCOME' | 'SUPPLIER_PAYMENT';
  let description: string;
  if (inbound) {
    lines.push({ accountId: p.accountId, debit: p.amount.minus(p.fee) });
    if (p.fee.gt(0)) {
      const fees = await systemCategory(tx, actor.companyId, SYSTEM_CATEGORY.FEES);
      lines.push({ accountId: (await systemAccount(tx, actor.companyId, 'EXPENSE')).id, debit: p.fee, categoryId: fees.id, memo: 'Payment processing fee' });
    }
    if (p.categoryId && !p.invoiceId) {
      type = 'INCOME';
      description = `Online income ${p.number}`;
      lines.push({ accountId: (await systemAccount(tx, actor.companyId, 'REVENUE')).id, credit: p.amount, categoryId: p.categoryId, customerId: p.customerId });
    } else {
      type = 'RECEIPT';
      description = `Customer receipt ${p.number}`;
      lines.push({ accountId: (await systemAccount(tx, actor.companyId, 'RECEIVABLE')).id, credit: p.amount, customerId: p.customerId });
    }
  } else {
    type = 'SUPPLIER_PAYMENT';
    description = `Supplier payment ${p.number}`;
    lines.push({ accountId: (await systemAccount(tx, actor.companyId, 'PAYABLE')).id, debit: p.amount, supplierId: p.supplierId });
    lines.push({ accountId: p.accountId, credit: p.amount });
  }

  const txn = await insertTransaction(tx, actor, {
    type,
    status: 'POSTED',
    date: p.date,
    amount: p.amount,
    totalAmount: p.amount,
    categoryId: type === 'INCOME' ? p.categoryId : null,
    paymentMethod: p.method,
    sourceAccountId: inbound ? null : p.accountId,
    destinationAccountId: inbound ? p.accountId : null,
    customerId: p.customerId,
    supplierId: p.supplierId,
    invoiceId: p.invoiceId,
    reference: p.gatewayPaymentId ?? p.reference,
    description,
  });
  await postJournal(tx, {
    companyId: actor.companyId,
    date: p.date,
    description: `${description} (${txn.number})`,
    transactionId: txn.id,
    createdById: actor.userId,
    paymentMethod: p.method,
    lines,
  });
  await applyAllocation(tx, {
    companyId: actor.companyId,
    paymentId: p.id,
    transactionId: txn.id,
    invoiceId: p.invoiceId,
    billTransactionId: p.billTransactionId,
    amount: p.amount,
    date: p.date,
  });
  const done = await tx.payment.update({ where: { id: p.id }, data: { status: 'SUCCESS', transactionId: txn.id } });
  await audit(tx, { ...actor, action: 'payment.status', entityType: 'Payment', entityId: p.id, summary: `Payment ${p.number} completed and posted as ${txn.number} (${p.amount.toFixed(2)})` });
  return done;
}

export async function failPayment(tx: Tx, actor: Actor, paymentId: string, status: 'FAILED' | 'CANCELLED', note?: string) {
  const p = await lockPayment(tx, actor.companyId, paymentId);
  if (p.status === status) return p;
  if (p.status !== 'PENDING') throw unprocessable(`A ${p.status.toLowerCase()} payment cannot be marked ${status.toLowerCase()}`, 'INVALID_STATE');
  const done = await tx.payment.update({ where: { id: p.id }, data: { status, notes: note ? [p.notes, note].filter(Boolean).join(' | ') : p.notes } });
  await audit(tx, { ...actor, action: 'payment.status', entityType: 'Payment', entityId: p.id, summary: `Payment ${p.number} marked ${status}` });
  return done;
}

export async function refundPayment(tx: Tx, actor: Actor, paymentId: string, input: { amount: Dec; date: string; reason: string }) {
  const p = await lockPayment(tx, actor.companyId, paymentId);
  if (p.status !== 'SUCCESS') throw unprocessable('Only successful payments can be refunded', 'INVALID_STATE');
  if (p.direction !== 'INBOUND') throw unprocessable('Only inbound payments can be refunded');
  const refundable = p.amount.minus(p.refundedAmount);
  if (input.amount.gt(refundable)) throw unprocessable(`Refund exceeds the refundable amount of ${refundable.toFixed(2)}`, 'OVER_REFUND');
  const date = parseDate(input.date);
  if (date < p.date) throw unprocessable('Refund date cannot be before the payment date');
  if (p.invoiceId) await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${p.invoiceId} AND "companyId" = ${actor.companyId} FOR UPDATE`;

  const direct = Boolean(p.categoryId && !p.invoiceId);
  const contra = await systemAccount(tx, actor.companyId, direct ? 'REVENUE' : 'RECEIVABLE');
  const txn = await insertTransaction(tx, actor, {
    type: 'REFUND',
    status: 'POSTED',
    date,
    amount: input.amount,
    totalAmount: input.amount,
    categoryId: direct ? p.categoryId : null,
    paymentMethod: p.method,
    sourceAccountId: p.accountId,
    customerId: p.customerId,
    invoiceId: p.invoiceId,
    reference: p.gatewayPaymentId ?? p.reference,
    description: `Refund of payment ${p.number}`,
    reason: input.reason,
  });
  await postJournal(tx, {
    companyId: actor.companyId,
    date,
    description: `Refund of ${p.number}: ${input.reason}`,
    transactionId: txn.id,
    createdById: actor.userId,
    paymentMethod: p.method,
    lines: [
      { accountId: contra.id, debit: input.amount, categoryId: direct ? p.categoryId : null, customerId: p.customerId },
      { accountId: p.accountId, credit: input.amount },
    ],
  });
  await applyAllocation(tx, { companyId: actor.companyId, paymentId: p.id, transactionId: txn.id, invoiceId: p.invoiceId, amount: input.amount.negated(), date });
  const refunded = p.refundedAmount.plus(input.amount);
  const done = await tx.payment.update({ where: { id: p.id }, data: { refundedAmount: refunded, refundStatus: refunded.gte(p.amount) ? 'FULL' : 'PARTIAL' } });
  await audit(tx, { ...actor, action: 'payment.refund', entityType: 'Payment', entityId: p.id, summary: `Refunded ${input.amount.toFixed(2)} of payment ${p.number} (${txn.number}). Reason: ${input.reason}` });
  return { payment: done, transaction: txn };
}

export const zeroFee = ZERO;
