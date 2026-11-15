import { Router } from 'express';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import type { Prisma as P } from '@prisma/client';
import { prisma } from '../db';
import { parse, zDate, zDateOptional, zId, zIdOptional, zMoneyOptional, zMoneyPositive, zPage, zText } from '../lib/validate';
import { AppError, notFound, unprocessable } from '../lib/errors';
import { D, money, toMinorUnits } from '../lib/money';
import { addDays, fmtDate, parseDate, today } from '../lib/dates';
import { companyOf, h, requirePerm } from '../middleware/auth';
import { idempotent } from '../middleware/idempotency';
import { cancelInvoice, createInvoice, displayStatus, issueInvoice, updateDraftInvoice } from '../services/invoices';
import { recordPayment } from '../services/payments';
import { createOrder, gatewayConfigured, gatewayStatus } from '../services/gateway';
import { attachmentPath } from './attachments';
import { actorOf, inTx, userNames } from './helpers';

export const invoicesRouter = Router();

const itemSchema = z.object({
  description: z.string({ required_error: 'Description is required' }).trim().min(1, 'Description is required').max(300),
  quantity: z.preprocess((v) => (typeof v === 'number' ? String(v) : v), z.string({ required_error: 'Quantity is required' }).regex(/^\d{1,9}(\.\d{1,3})?$/, 'Enter a valid quantity').transform((s) => D(s)).refine((d) => d.gt(0), 'Quantity must be greater than zero')),
  unitPrice: zMoneyOptional,
  discount: zMoneyOptional,
  taxRate: z.preprocess((v) => (v === '' || v === null || v === undefined ? '0' : typeof v === 'number' ? String(v) : v), z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'Enter a valid tax rate').transform((s) => D(s)).refine((d) => d.lte(100), 'Tax rate cannot exceed 100')),
  categoryId: zId,
});
const invoiceSchema = z.object({
  customerId: zId,
  issueDate: zDate,
  dueDate: zDateOptional,
  notes: zText(1000),
  terms: zText(2000),
  items: z.array(itemSchema).min(1, 'Add at least one line item').max(100),
  issue: z.boolean().default(false),
});

const view = (i: P.InvoiceGetPayload<{ include: { customer: true } }>) => ({
  id: i.id, number: i.number, customerId: i.customerId, customer: i.customer.name, status: displayStatus(i), storedStatus: i.status,
  issueDate: fmtDate(i.issueDate), dueDate: fmtDate(i.dueDate), currency: i.currency, subtotal: money(i.subtotal), discountTotal: money(i.discountTotal),
  taxTotal: money(i.taxTotal), total: money(i.total), amountPaid: money(i.amountPaid), outstanding: money(i.status === 'CANCELLED' || i.status === 'DRAFT' ? 0 : i.total.minus(i.amountPaid)),
});

invoicesRouter.get('/', requirePerm('invoices.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const q = parse(zPage.extend({ status: z.enum(['DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED']).optional(), customerId: zIdOptional, from: zDateOptional, to: zDateOptional, q: zText(100), open: z.string().optional() }), req.query);
  const where: P.InvoiceWhereInput = { companyId };
  if (q.status === 'OVERDUE') Object.assign(where, { status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, dueDate: { lt: parseDate(today()) } });
  else if (q.status) where.status = q.status;
  if (q.open) where.status = { in: ['ISSUED', 'PARTIALLY_PAID'] };
  if (q.customerId) where.customerId = q.customerId;
  if (q.from || q.to) where.issueDate = { ...(q.from ? { gte: parseDate(q.from) } : {}), ...(q.to ? { lte: parseDate(q.to) } : {}) };
  if (q.q) where.OR = [{ number: { contains: q.q, mode: 'insensitive' } }, { customer: { name: { contains: q.q, mode: 'insensitive' } } }];
  const [rows, total, open] = await Promise.all([
    prisma.invoice.findMany({ where, include: { customer: true }, orderBy: [{ issueDate: 'desc' }, { number: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.invoice.count({ where }),
    prisma.invoice.aggregate({ where: { companyId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, _sum: { total: true, amountPaid: true }, _count: true }),
  ]);
  const overdue = await prisma.invoice.aggregate({ where: { companyId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] }, dueDate: { lt: parseDate(today()) } }, _sum: { total: true, amountPaid: true }, _count: true });
  res.json({
    data: rows.map(view),
    meta: {
      page: q.page, pageSize: q.pageSize, total,
      summary: {
        openCount: open._count, openOutstanding: money(D(open._sum.total).minus(D(open._sum.amountPaid))),
        overdueCount: overdue._count, overdueOutstanding: money(D(overdue._sum.total).minus(D(overdue._sum.amountPaid))),
      },
    },
  });
}));

async function withDefaults(companyId: string, body: unknown) {
  const d = parse(invoiceSchema, body);
  const settings = await prisma.companySettings.findUnique({ where: { companyId } });
  return { ...d, dueDate: d.dueDate ?? addDays(d.issueDate, settings?.invoiceDueDays ?? 15) };
}

invoicesRouter.post('/', requirePerm('invoices.manage'), idempotent, h(async (req, res) => {
  const d = await withDefaults(companyOf(req), req.body);
  const actor = actorOf(req);
  const invoice = await inTx(async (tx) => {
    const inv = await createInvoice(tx, actor, d);
    return d.issue ? issueInvoice(tx, actor, inv.id) : inv;
  });
  res.status(201).json({ data: invoice });
}));

async function loadInvoice(companyId: string, id: string) {
  const inv = await prisma.invoice.findFirst({
    where: { id, companyId },
    include: { customer: true, items: { orderBy: { position: 'asc' }, include: { category: { select: { name: true } } } }, payments: { orderBy: { createdAt: 'asc' } } },
  });
  if (!inv) throw notFound('Invoice');
  return inv;
}

invoicesRouter.get('/:id', requirePerm('invoices.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const inv = await loadInvoice(companyId, req.params.id);
  const names = await userNames([inv.createdById]);
  res.json({
    data: {
      ...view(inv), notes: inv.notes, terms: inv.terms, cancelReason: inv.cancelReason, createdBy: names.get(inv.createdById) ?? null, createdAt: inv.createdAt,
      customerDetails: { name: inv.customer.name, businessName: inv.customer.businessName, email: inv.customer.email, phone: inv.customer.phone, address: inv.customer.address, gstin: inv.customer.gstin },
      items: inv.items.map((it) => ({
        id: it.id, description: it.description, quantity: it.quantity.toString(), unitPrice: money(it.unitPrice), discount: money(it.discount), taxRate: it.taxRate.toFixed(2),
        categoryId: it.categoryId, category: it.category.name, lineNet: money(it.lineNet), lineTax: money(it.lineTax), lineTotal: money(it.lineTotal),
      })),
      payments: inv.payments.map((p) => ({ id: p.id, number: p.number, date: fmtDate(p.date), method: p.method, amount: money(p.amount), fee: money(p.fee), status: p.status, refundedAmount: money(p.refundedAmount), reference: p.gatewayPaymentId ?? p.reference, transactionId: p.transactionId })),
      gateway: gatewayStatus(),
    },
  });
}));

invoicesRouter.patch('/:id', requirePerm('invoices.manage'), h(async (req, res) => {
  const d = await withDefaults(companyOf(req), req.body);
  res.json({ data: await inTx((tx) => updateDraftInvoice(tx, actorOf(req), req.params.id, d)) });
}));

invoicesRouter.post('/:id/issue', requirePerm('invoices.manage'), h(async (req, res) => {
  res.json({ data: await inTx((tx) => issueInvoice(tx, actorOf(req), req.params.id)) });
}));

invoicesRouter.post('/:id/cancel', requirePerm('invoices.manage'), h(async (req, res) => {
  const d = parse(z.object({ reason: z.string({ required_error: 'A reason is required' }).trim().min(5, 'Give a reason (at least 5 characters)').max(500) }), req.body);
  res.json({ data: await inTx((tx) => cancelInvoice(tx, actorOf(req), req.params.id, d.reason)) });
}));

const METHODS = ['CASH', 'BANK_TRANSFER', 'UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'PAYMENT_GATEWAY', 'CHEQUE', 'OTHER'] as const;

invoicesRouter.post('/:id/payments', requirePerm('payments.manage'), idempotent, h(async (req, res) => {
  const d = parse(z.object({
    date: zDate, amount: zMoneyPositive, paymentMethod: z.enum(METHODS, { errorMap: () => ({ message: 'Select a payment method' }) }), accountId: zId,
    fee: zMoneyOptional, gateway: zText(40), gatewayPaymentId: zText(100), reference: zText(100), notes: zText(500),
  }), req.body);
  if (d.date > today()) throw new AppError(400, 'VALIDATION_ERROR', 'The date cannot be in the future', { fields: { date: 'Cannot be in the future' } });
  const payment = await inTx((tx) => recordPayment(tx, actorOf(req), {
    direction: 'INBOUND', status: 'SUCCESS', method: d.paymentMethod, invoiceId: req.params.id, accountId: d.accountId, date: d.date, amount: d.amount,
    fee: d.fee, gateway: d.gateway, gatewayPaymentId: d.gatewayPaymentId, reference: d.reference, notes: d.notes,
  }));
  res.status(201).json({ data: payment });
}));

// Real collection: only available when a gateway is configured. Creates a server-side order and a PENDING payment.
invoicesRouter.post('/:id/payment-order', requirePerm('payments.manage'), idempotent, h(async (req, res) => {
  const companyId = companyOf(req);
  if (!gatewayConfigured()) throw new AppError(409, 'GATEWAY_NOT_CONFIGURED', 'No payment gateway is configured. Record the payment manually instead.');
  const d = parse(z.object({ accountId: zId }), req.body);
  const inv = await loadInvoice(companyId, req.params.id);
  if (!['ISSUED', 'PARTIALLY_PAID'].includes(inv.status)) throw unprocessable('Only issued invoices can be paid online', 'INVALID_STATE');
  const outstanding = inv.total.minus(inv.amountPaid);
  const order = await createOrder(toMinorUnits(outstanding), inv.currency, inv.number, { companyId, invoiceId: inv.id });
  const payment = await inTx((tx) => recordPayment(tx, actorOf(req), {
    direction: 'INBOUND', status: 'PENDING', method: 'PAYMENT_GATEWAY', gateway: 'razorpay', gatewayOrderId: order.id, invoiceId: inv.id, accountId: d.accountId,
    date: today(), amount: outstanding, fee: D(0), notes: 'Awaiting gateway confirmation',
  }));
  res.status(201).json({ data: { paymentId: payment.id, orderId: order.id, amount: order.amount, currency: order.currency, keyId: gatewayStatus().keyId, invoiceNumber: inv.number, customer: { name: inv.customer.name, email: inv.customer.email, phone: inv.customer.phone } } });
}));

invoicesRouter.get('/:id/pdf', requirePerm('invoices.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const inv = await loadInvoice(companyId, req.params.id);
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } });
  const settings = await prisma.companySettings.findUnique({ where: { companyId } });
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${inv.number.replace(/[^A-Za-z0-9_.-]/g, '_')}.pdf"`);
  doc.pipe(res);
  const W = doc.page.width - 80;
  const fmt = (v: unknown) => {
    const [int, dec] = money(v as never).split('.');
    return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + dec;
  };

  let top = 40;
  if (company.logoAttachmentId) {
    try {
      const { att, file } = await attachmentPath(companyId, company.logoAttachmentId);
      if (['image/png', 'image/jpeg'].includes(att.mimeType)) { doc.image(file, 40, 40, { fit: [90, 60] }); top = 108; }
    } catch { /* logo is optional */ }
  }
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#0F1E3D').text(company.name, 40, top, { width: W / 2 });
  doc.font('Helvetica').fontSize(9).fillColor('#444');
  const addr = [company.address, [company.city, company.state, company.postalCode].filter(Boolean).join(', '), company.country].filter(Boolean).join('\n');
  if (addr) doc.text(addr, { width: W / 2 });
  if (company.gstin) doc.text(`GSTIN: ${company.gstin}`);
  if (company.pan) doc.text(`PAN: ${company.pan}`);
  if (company.email || company.phone) doc.text([company.email, company.phone].filter(Boolean).join('  |  '));
  const leftBottom = doc.y;

  const status = displayStatus(inv);
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#0F1E3D').text(inv.taxTotal.gt(0) ? 'TAX INVOICE' : 'INVOICE', 40 + W / 2, 40, { width: W / 2, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor('#222');
  for (const [k, v] of [['Invoice No.', inv.number], ['Invoice Date', fmtDate(inv.issueDate)], ['Due Date', fmtDate(inv.dueDate)], ['Status', status.replace('_', ' ')]]) {
    doc.text(`${k}: ${v}`, 40 + W / 2, undefined, { width: W / 2, align: 'right' });
  }
  doc.y = Math.max(leftBottom, doc.y) + 18;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text('BILL TO', 40);
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text(inv.customer.businessName || inv.customer.name);
  doc.font('Helvetica').fontSize(9).fillColor('#444');
  if (inv.customer.businessName) doc.text(inv.customer.name);
  if (inv.customer.address) doc.text(inv.customer.address, { width: W / 2 });
  if (inv.customer.gstin) doc.text(`GSTIN: ${inv.customer.gstin}`);
  if (inv.customer.email || inv.customer.phone) doc.text([inv.customer.email, inv.customer.phone].filter(Boolean).join('  |  '));
  doc.moveDown(1.2);

  const cols = [{ l: '#', w: 22, a: 'left' }, { l: 'Description', w: W - 22 - 52 - 70 - 60 - 48 - 78, a: 'left' }, { l: 'Qty', w: 52, a: 'right' }, { l: 'Unit Price', w: 70, a: 'right' }, { l: 'Discount', w: 60, a: 'right' }, { l: `${settings?.taxLabel ?? 'Tax'} %`, w: 48, a: 'right' }, { l: 'Amount', w: 78, a: 'right' }] as const;
  const row = (cells: string[], bold = false, fill?: string) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    const hgt = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: cols[i].w - 8 }))) + 10;
    if (doc.y + hgt > doc.page.height - 60) doc.addPage();
    const y = doc.y;
    if (fill) doc.rect(40, y, W, hgt).fill(fill);
    doc.fillColor(fill === '#0F1E3D' ? '#FFF' : '#111');
    let x = 40;
    cells.forEach((c, i) => { doc.text(c, x + 4, y + 5, { width: cols[i].w - 8, align: cols[i].a }); x += cols[i].w; });
    doc.moveTo(40, y + hgt).lineTo(40 + W, y + hgt).strokeColor('#DDD').lineWidth(0.5).stroke();
    doc.y = y + hgt;
  };
  row(cols.map((c) => c.l), true, '#0F1E3D');
  inv.items.forEach((it, i) => row([String(i + 1), it.description, it.quantity.toString(), fmt(it.unitPrice), fmt(it.discount), it.taxRate.toFixed(2), fmt(it.lineNet)]));
  doc.moveDown(0.8);

  const totals: Array<[string, string, boolean?]> = [['Subtotal', fmt(inv.subtotal)]];
  if (inv.discountTotal.gt(0)) totals.push(['Discount', '-' + fmt(inv.discountTotal)]);
  if (inv.taxTotal.gt(0)) totals.push([settings?.taxLabel ?? 'Tax', fmt(inv.taxTotal)]);
  totals.push([`Total (${inv.currency})`, fmt(inv.total), true], ['Amount Paid', fmt(inv.amountPaid)], ['Balance Due', fmt(inv.status === 'CANCELLED' ? 0 : inv.total.minus(inv.amountPaid)), true]);
  if (doc.y + totals.length * 16 > doc.page.height - 60) doc.addPage();
  for (const [k, v, bold] of totals) {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor('#111');
    doc.text(k, 40 + W - 230, y, { width: 130, align: 'right' });
    doc.text(v, 40 + W - 95, y, { width: 95, align: 'right' });
    doc.y = y + 16;
  }
  doc.x = 40;
  if (inv.status === 'CANCELLED') doc.moveDown().font('Helvetica-Bold').fontSize(11).fillColor('#B42318').text('This invoice has been cancelled.', 40);
  if (inv.notes) doc.moveDown().font('Helvetica-Bold').fontSize(9).fillColor('#666').text('NOTES', 40).font('Helvetica').fillColor('#333').text(inv.notes, { width: W });
  if (inv.terms) doc.moveDown().font('Helvetica-Bold').fontSize(9).fillColor('#666').text('TERMS', 40).font('Helvetica').fillColor('#333').text(inv.terms, { width: W });
  doc.end();
}));
