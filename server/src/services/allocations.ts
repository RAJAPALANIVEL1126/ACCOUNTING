import type { InvoiceStatus } from '@prisma/client';
import { Tx } from '../db';
import { Dec } from '../lib/money';
import { unprocessable } from '../lib/errors';

export interface AllocationInput {
  companyId: string;
  paymentId: string;
  transactionId: string;
  invoiceId?: string | null;
  billTransactionId?: string | null;
  amount: Dec; // signed
  date: Date;
}

export const invoiceStatusFor = (total: Dec, paid: Dec): InvoiceStatus => (paid.lte(0) ? 'ISSUED' : paid.gte(total) ? 'PAID' : 'PARTIALLY_PAID');

/**
 * Records a signed allocation and keeps the settled document in step, inside the caller's
 * DB transaction. Callers must already hold a row lock on the invoice / bill.
 */
export async function applyAllocation(tx: Tx, a: AllocationInput) {
  if (!a.invoiceId && !a.billTransactionId) return;
  await tx.paymentAllocation.create({
    data: {
      companyId: a.companyId,
      paymentId: a.paymentId,
      transactionId: a.transactionId,
      invoiceId: a.invoiceId ?? null,
      billTransactionId: a.billTransactionId ?? null,
      amount: a.amount,
      date: a.date,
    },
  });
  if (a.invoiceId) {
    const inv = await tx.invoice.findFirstOrThrow({ where: { id: a.invoiceId, companyId: a.companyId } });
    const paid = inv.amountPaid.plus(a.amount);
    if (paid.lt(0) || paid.gt(inv.total)) throw unprocessable('Payment allocation would exceed the invoice total', 'OVERPAYMENT');
    await tx.invoice.update({ where: { id: inv.id }, data: { amountPaid: paid, status: invoiceStatusFor(inv.total, paid) } });
  }
  if (a.billTransactionId) {
    const bill = await tx.transaction.findFirstOrThrow({ where: { id: a.billTransactionId, companyId: a.companyId } });
    const paid = bill.amountPaid.plus(a.amount);
    if (paid.lt(0) || paid.gt(bill.totalAmount)) throw unprocessable('Payment allocation would exceed the bill total', 'OVERPAYMENT');
    await tx.transaction.update({ where: { id: bill.id }, data: { amountPaid: paid } });
  }
}
