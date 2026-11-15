import { Tx } from '../db';
import { AppError, notFound, unprocessable } from '../lib/errors';
import { Dec } from '../lib/money';
import { calcInvoice } from '../lib/invoiceCalc';
import { nextSequence, pad } from '../lib/sequence';
import { parseDate, today } from '../lib/dates';
import { audit } from '../lib/audit';
import { LineInput, mirrorLines, postJournal, systemAccount } from './ledger';
import { Actor, categoryOf, companyCurrency } from './transactions';

export interface InvoiceItemInput {
  description: string;
  quantity: Dec;
  unitPrice: Dec;
  discount: Dec;
  taxRate: Dec;
  categoryId: string;
}
export interface InvoiceInput {
  customerId: string;
  issueDate: string;
  dueDate: string;
  notes?: string;
  terms?: string;
  items: InvoiceItemInput[];
}

async function buildItems(tx: Tx, companyId: string, items: InvoiceItemInput[]) {
  if (!items.length) throw new AppError(400, 'VALIDATION_ERROR', 'Add at least one line item', { fields: { items: 'Add at least one line item' } });
  for (const id of new Set(items.map((i) => i.categoryId))) await categoryOf(tx, companyId, id, 'INCOME');
  const calc = calcInvoice(items);
  return {
    calc,
    rows: items.map((it, i) => ({
      position: i + 1,
      description: it.description,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      discount: calc.items[i].discount,
      taxRate: it.taxRate,
      categoryId: it.categoryId,
      lineNet: calc.items[i].lineNet,
      lineTax: calc.items[i].lineTax,
      lineTotal: calc.items[i].lineTotal,
    })),
  };
}

function assertDates(issueDate: string, dueDate: string) {
  if (dueDate < issueDate) throw new AppError(400, 'VALIDATION_ERROR', 'Due date cannot be before the invoice date', { fields: { dueDate: 'Cannot be before the invoice date' } });
}

export async function createInvoice(tx: Tx, actor: Actor, input: InvoiceInput) {
  assertDates(input.issueDate, input.dueDate);
  const customer = await tx.customer.findFirst({ where: { id: input.customerId, companyId: actor.companyId } });
  if (!customer) throw new AppError(400, 'VALIDATION_ERROR', 'Select a valid customer', { fields: { customerId: 'Select a valid customer' } });
  const { calc, rows } = await buildItems(tx, actor.companyId, input.items);
  const settings = await tx.companySettings.findUnique({ where: { companyId: actor.companyId } });
  const number = (settings?.invoicePrefix ?? 'INV-') + pad(await nextSequence(tx, actor.companyId, 'INV'), 5);
  const invoice = await tx.invoice.create({
    data: {
      companyId: actor.companyId,
      number,
      customerId: customer.id,
      status: 'DRAFT',
      issueDate: parseDate(input.issueDate),
      dueDate: parseDate(input.dueDate),
      currency: await companyCurrency(tx, actor.companyId),
      subtotal: calc.subtotal,
      discountTotal: calc.discountTotal,
      taxTotal: calc.taxTotal,
      total: calc.total,
      notes: input.notes ?? settings?.invoiceNotes ?? null,
      terms: input.terms ?? settings?.invoiceTerms ?? null,
      createdById: actor.userId,
      items: { create: rows },
    },
  });
  await audit(tx, { ...actor, action: 'invoice.create', entityType: 'Invoice', entityId: invoice.id, summary: `Created draft invoice ${number} for ${customer.name} — total ${calc.total.toFixed(2)}` });
  return invoice;
}

async function lockInvoice(tx: Tx, companyId: string, id: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Invoice" WHERE "id" = ${id} AND "companyId" = ${companyId} FOR UPDATE`;
  if (!rows.length) throw notFound('Invoice');
  return tx.invoice.findUniqueOrThrow({ where: { id }, include: { items: { orderBy: { position: 'asc' } }, customer: true } });
}

export async function updateDraftInvoice(tx: Tx, actor: Actor, id: string, input: InvoiceInput) {
  const inv = await lockInvoice(tx, actor.companyId, id);
  if (inv.status !== 'DRAFT') throw unprocessable('Only draft invoices can be edited. Cancel and re-issue instead.', 'INVALID_STATE');
  assertDates(input.issueDate, input.dueDate);
  const customer = await tx.customer.findFirst({ where: { id: input.customerId, companyId: actor.companyId } });
  if (!customer) throw new AppError(400, 'VALIDATION_ERROR', 'Select a valid customer', { fields: { customerId: 'Select a valid customer' } });
  const { calc, rows } = await buildItems(tx, actor.companyId, input.items);
  await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
  const updated = await tx.invoice.update({
    where: { id },
    data: {
      customerId: customer.id,
      issueDate: parseDate(input.issueDate),
      dueDate: parseDate(input.dueDate),
      subtotal: calc.subtotal,
      discountTotal: calc.discountTotal,
      taxTotal: calc.taxTotal,
      total: calc.total,
      notes: input.notes ?? null,
      terms: input.terms ?? null,
      items: { create: rows },
    },
  });
  await audit(tx, { ...actor, action: 'invoice.update', entityType: 'Invoice', entityId: id, summary: `Updated draft invoice ${inv.number} — total ${inv.total.toFixed(2)} → ${calc.total.toFixed(2)}` });
  return updated;
}

/** Issuing recognises revenue once (Dr Receivable / Cr Revenue + Output tax). Payments later only clear the receivable. */
export async function issueInvoice(tx: Tx, actor: Actor, id: string) {
  const inv = await lockInvoice(tx, actor.companyId, id);
  if (inv.status !== 'DRAFT') throw unprocessable('Only draft invoices can be issued', 'INVALID_STATE');
  if (inv.total.lte(0)) throw unprocessable('An invoice with a zero total cannot be issued');
  const receivable = await systemAccount(tx, actor.companyId, 'RECEIVABLE');
  const revenue = await systemAccount(tx, actor.companyId, 'REVENUE');
  const taxOut = await systemAccount(tx, actor.companyId, 'TAX_OUTPUT');
  const lines: LineInput[] = [{ accountId: receivable.id, debit: inv.total, customerId: inv.customerId }];
  for (const it of inv.items) lines.push({ accountId: revenue.id, credit: it.lineNet, categoryId: it.categoryId, customerId: inv.customerId, memo: it.description.slice(0, 200) });
  lines.push({ accountId: taxOut.id, credit: inv.taxTotal });
  await postJournal(tx, { companyId: actor.companyId, date: inv.issueDate, description: `Invoice ${inv.number} — ${inv.customer.name}`, invoiceId: inv.id, createdById: actor.userId, lines });
  const updated = await tx.invoice.update({ where: { id }, data: { status: 'ISSUED' } });
  await audit(tx, { ...actor, action: 'invoice.issue', entityType: 'Invoice', entityId: id, summary: `Issued invoice ${inv.number} to ${inv.customer.name} for ${inv.total.toFixed(2)}` });
  return updated;
}

export async function cancelInvoice(tx: Tx, actor: Actor, id: string, reason: string) {
  const inv = await lockInvoice(tx, actor.companyId, id);
  if (inv.status === 'CANCELLED') throw unprocessable('Invoice is already cancelled', 'INVALID_STATE');
  if (inv.amountPaid.gt(0)) throw unprocessable('This invoice has payments. Refund or reverse them before cancelling.', 'HAS_PAYMENTS');
  if (inv.status !== 'DRAFT') {
    const entries = await tx.journalEntry.findMany({ where: { invoiceId: id, isReversal: false }, include: { lines: true } });
    const date = parseDate(today()) < inv.issueDate ? inv.issueDate : parseDate(today());
    for (const e of entries) {
      await postJournal(tx, {
        companyId: actor.companyId,
        date,
        description: `Cancellation of invoice ${inv.number}: ${reason}`,
        invoiceId: id,
        isReversal: true,
        createdById: actor.userId,
        lines: mirrorLines(e.lines),
      });
    }
  }
  const updated = await tx.invoice.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: reason } });
  await audit(tx, { ...actor, action: 'invoice.cancel', entityType: 'Invoice', entityId: id, summary: `Cancelled invoice ${inv.number} (${inv.total.toFixed(2)}). Reason: ${reason}` });
  return updated;
}

/** Overdue is derived, never stored: an open invoice past its due date. */
export function displayStatus(inv: { status: string; dueDate: Date }): string {
  if (['ISSUED', 'PARTIALLY_PAID'].includes(inv.status) && inv.dueDate.toISOString().slice(0, 10) < today()) return 'OVERDUE';
  return inv.status;
}
