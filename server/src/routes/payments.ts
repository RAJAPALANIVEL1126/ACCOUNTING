import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Prisma as P } from '@prisma/client';
import { prisma, Prisma } from '../db';
import { parse, zDate, zDateOptional, zId, zIdOptional, zMoneyOptional, zMoneyPositive, zPage, zText } from '../lib/validate';
import { AppError, notFound } from '../lib/errors';
import { audit, auditCtx } from '../lib/audit';
import { D, fromMinorUnits, money, sum, toMinorUnits } from '../lib/money';
import { fmtDate, today } from '../lib/dates';
import { sha256 } from '../lib/tokens';
import { log } from '../lib/logger';
import { companyOf, h, requirePerm } from '../middleware/auth';
import { idempotent } from '../middleware/idempotency';
import { failPayment, recordPayment, refundPayment, settlePayment } from '../services/payments';
import { fetchOrderPayments, gatewayConfigured, gatewayStatus, mapGatewayMethod, verifyWebhookSignature } from '../services/gateway';
import type { Actor } from '../services/transactions';
import { actorOf, inTx } from './helpers';

export const paymentsRouter = Router();

const ONLINE = ['UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'PAYMENT_GATEWAY', 'BANK_TRANSFER'] as const;
const METHODS = ['CASH', 'CHEQUE', 'OTHER', ...ONLINE] as const;

paymentsRouter.get('/gateway', requirePerm('payments.view'), h(async (_req, res) => {
  res.json({ data: gatewayStatus() });
}));

paymentsRouter.get('/', requirePerm('payments.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const q = parse(zPage.extend({
    status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'REVERSED']).optional(), method: z.enum(METHODS).optional(), direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
    recon: z.enum(['UNRECONCILED', 'RECONCILED']).optional(), online: z.string().optional(), from: zDateOptional, to: zDateOptional, q: zText(100),
  }), req.query);
  const where: P.PaymentWhereInput = { companyId };
  if (q.status) where.status = q.status;
  if (q.method) where.method = q.method;
  else if (q.online) where.method = { in: [...ONLINE] };
  if (q.direction) where.direction = q.direction;
  if (q.recon) where.reconStatus = q.recon;
  if (q.from || q.to) where.date = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
  if (q.q) {
    const c = { contains: q.q, mode: 'insensitive' as const };
    where.OR = [{ number: c }, { gatewayPaymentId: c }, { reference: c }, { customer: { name: c } }, { supplier: { name: c } }, { invoice: { number: c } }];
  }
  const [rows, total, byStatus] = await Promise.all([
    prisma.payment.findMany({ where, include: { customer: { select: { name: true } }, supplier: { select: { name: true } }, invoice: { select: { number: true } } }, orderBy: [{ date: 'desc' }, { number: 'desc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.payment.count({ where }),
    prisma.payment.groupBy({ by: ['status'], where, _sum: { amount: true, fee: true, refundedAmount: true }, _count: true }),
  ]);
  const ok = byStatus.find((s) => s.status === 'SUCCESS'), pending = byStatus.find((s) => s.status === 'PENDING');
  res.json({
    data: rows.map((p) => ({
      id: p.id, number: p.number, direction: p.direction, status: p.status, method: p.method, gateway: p.gateway, gatewayPaymentId: p.gatewayPaymentId, reference: p.reference,
      party: p.customer?.name ?? p.supplier?.name ?? null, invoice: p.invoice?.number ?? null, invoiceId: p.invoiceId, date: fmtDate(p.date), amount: money(p.amount), fee: money(p.fee),
      net: money(p.amount.minus(p.fee)), refundedAmount: money(p.refundedAmount), refundStatus: p.refundStatus, reconStatus: p.reconStatus, transactionId: p.transactionId, notes: p.notes,
    })),
    meta: {
      page: q.page, pageSize: q.pageSize, total,
      summary: {
        successAmount: money(ok?._sum.amount), successCount: ok?._count ?? 0, fees: money(ok?._sum.fee), refunded: money(ok?._sum.refundedAmount),
        pendingAmount: money(pending?._sum.amount), pendingCount: pending?._count ?? 0,
      },
      gateway: gatewayStatus(),
    },
  });
}));

paymentsRouter.post('/', requirePerm('payments.manage'), idempotent, h(async (req, res) => {
  const d = parse(z.object({
    direction: z.enum(['INBOUND', 'OUTBOUND']).default('INBOUND'),
    status: z.enum(['SUCCESS', 'PENDING'], { errorMap: () => ({ message: 'Select a payment status' }) }).default('SUCCESS'),
    method: z.enum(METHODS, { errorMap: () => ({ message: 'Select a payment method' }) }),
    gateway: zText(40), gatewayPaymentId: zText(100),
    customerId: zIdOptional, supplierId: zIdOptional, invoiceId: zIdOptional, billTransactionId: zIdOptional, categoryId: zIdOptional,
    accountId: zId, date: zDate, amount: zMoneyPositive, fee: zMoneyOptional, reference: zText(100), notes: zText(500),
  }), req.body);
  if (d.date > today()) throw new AppError(400, 'VALIDATION_ERROR', 'The date cannot be in the future', { fields: { date: 'Cannot be in the future' } });
  const payment = await inTx((tx) => recordPayment(tx, actorOf(req), d));
  res.status(201).json({ data: payment });
}));

// Recording mode: staff confirm the outcome of a pending payment after checking the bank / gateway dashboard.
paymentsRouter.post('/:id/status', requirePerm('payments.manage'), h(async (req, res) => {
  const d = parse(z.object({ status: z.enum(['SUCCESS', 'FAILED', 'CANCELLED']), gatewayPaymentId: zText(100), note: zText(300) }), req.body);
  const companyId = companyOf(req);
  const existing = await prisma.payment.findFirst({ where: { id: req.params.id, companyId } });
  if (!existing) throw notFound('Payment');
  if (existing.gateway === 'razorpay' && existing.gatewayOrderId && gatewayConfigured() && d.status === 'SUCCESS') {
    throw new AppError(422, 'GATEWAY_MANAGED', 'This payment is managed by the gateway. Use "Verify with gateway" — its status cannot be set by hand.');
  }
  const payment = await inTx((tx) => d.status === 'SUCCESS'
    ? settlePayment(tx, actorOf(req), req.params.id, d.gatewayPaymentId ? { gatewayPaymentId: d.gatewayPaymentId } : {})
    : failPayment(tx, actorOf(req), req.params.id, d.status, d.note));
  res.json({ data: payment });
}));

// Server-to-server confirmation: asks the gateway what really happened to the order.
paymentsRouter.post('/:id/verify', requirePerm('payments.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const p = await prisma.payment.findFirst({ where: { id: req.params.id, companyId } });
  if (!p) throw notFound('Payment');
  if (!p.gatewayOrderId || p.gateway !== 'razorpay') throw new AppError(422, 'INVALID_STATE', 'This payment was not created through the payment gateway');
  if (p.status !== 'PENDING') return res.json({ data: p });
  const { items } = await fetchOrderPayments(p.gatewayOrderId);
  const captured = items.find((x) => x.status === 'captured');
  if (!captured) return res.json({ data: p, meta: { message: 'The gateway has not captured a payment for this order yet.' } });
  if (captured.amount !== toMinorUnits(p.amount)) throw new AppError(422, 'AMOUNT_MISMATCH', 'The captured amount does not match the expected amount. Investigate before posting.');
  const done = await inTx((tx) => settlePayment(tx, actorOf(req), p.id, { gatewayPaymentId: captured.id, method: mapGatewayMethod(captured.method), fee: fromMinorUnits(captured.fee ?? 0) }));
  res.json({ data: done });
}));

paymentsRouter.post('/:id/refund', requirePerm('payments.manage'), idempotent, h(async (req, res) => {
  const d = parse(z.object({ amount: zMoneyPositive, date: zDate, reason: z.string({ required_error: 'A reason is required' }).trim().min(5, 'Give a reason (at least 5 characters)').max(500) }), req.body);
  if (d.date > today()) throw new AppError(400, 'VALIDATION_ERROR', 'The date cannot be in the future', { fields: { date: 'Cannot be in the future' } });
  const out = await inTx((tx) => refundPayment(tx, actorOf(req), req.params.id, d));
  res.status(201).json({ data: out.payment });
}));

paymentsRouter.post('/:id/reconcile', requirePerm('payments.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const d = parse(z.object({ reconciled: z.boolean() }), req.body);
  const p = await prisma.payment.findFirst({ where: { id: req.params.id, companyId } });
  if (!p) throw notFound('Payment');
  if (d.reconciled && p.status !== 'SUCCESS') throw new AppError(422, 'INVALID_STATE', 'Only successful payments can be reconciled');
  const updated = await prisma.payment.update({ where: { id: p.id }, data: { reconStatus: d.reconciled ? 'RECONCILED' : 'UNRECONCILED', reconciledAt: d.reconciled ? new Date() : null } });
  await audit(prisma, { ...auditCtx(req), action: 'payment.reconcile', entityType: 'Payment', entityId: p.id, summary: `Payment ${p.number} marked ${updated.reconStatus}` });
  res.json({ data: updated });
}));

// ───────────────────────── Gateway webhook (no session; authenticated by signature) ─────────────────────────

const systemActor = (companyId: string, userId: string): Actor => ({ companyId, userId, userName: 'Payment gateway webhook' });

export async function razorpayWebhook(req: Request, res: Response) {
  const raw = req.rawBody;
  const signature = req.headers['x-razorpay-signature'];
  if (!gatewayConfigured()) return res.status(503).json({ error: { code: 'GATEWAY_NOT_CONFIGURED', message: 'Payment gateway is not configured' } });
  if (!raw || !verifyWebhookSignature(raw, typeof signature === 'string' ? signature : undefined)) {
    log.warn('Rejected webhook with invalid signature', { ip: req.ip });
    return res.status(400).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature' } });
  }
  let body: { event?: string; payload?: { payment?: { entity?: Record<string, unknown> }; refund?: { entity?: Record<string, unknown> } } };
  try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed payload' } }); }
  const eventType = String(body.event ?? 'unknown');
  const headerId = req.headers['x-razorpay-event-id'];
  const eventId = typeof headerId === 'string' && headerId ? headerId : sha256(raw.toString('utf8'));

  // Idempotency: the unique (provider, eventId) insert is the lock. A redelivery is acknowledged and ignored.
  let event;
  try {
    event = await prisma.paymentWebhookEvent.create({ data: { provider: 'razorpay', eventId, eventType, payloadHash: sha256(raw.toString('utf8')) } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const prior = await prisma.paymentWebhookEvent.findUnique({ where: { provider_eventId: { provider: 'razorpay', eventId } } });
      if (prior && prior.status !== 'FAILED') return res.json({ data: { received: true, duplicate: true } });
      event = prior!;
    } else throw e;
  }

  try {
    const pay = body.payload?.payment?.entity as { id?: string; order_id?: string; amount?: number; method?: string; fee?: number } | undefined;
    let outcome = 'IGNORED';
    if (pay?.order_id && (eventType === 'payment.captured' || eventType === 'payment.failed')) {
      const payment = await prisma.payment.findFirst({ where: { gateway: 'razorpay', gatewayOrderId: pay.order_id } });
      if (!payment) outcome = 'UNKNOWN_ORDER';
      else if (eventType === 'payment.failed') {
        if (payment.status === 'PENDING') await inTx((tx) => failPayment(tx, systemActor(payment.companyId, payment.createdById ?? ''), payment.id, 'FAILED', 'Gateway reported failure'));
        outcome = 'PROCESSED';
      } else {
        if (pay.amount !== toMinorUnits(payment.amount)) throw new Error(`Amount mismatch for order ${pay.order_id}: expected ${toMinorUnits(payment.amount)}, got ${pay.amount}`);
        await inTx((tx) => settlePayment(tx, systemActor(payment.companyId, payment.createdById ?? ''), payment.id, { gatewayPaymentId: pay.id, method: mapGatewayMethod(pay.method), fee: fromMinorUnits(pay.fee ?? 0) }));
        outcome = 'PROCESSED';
      }
    } else if (eventType === 'refund.processed') {
      const refund = body.payload?.refund?.entity as { id?: string; payment_id?: string; amount?: number } | undefined;
      const payment = refund?.payment_id ? await prisma.payment.findFirst({ where: { gateway: 'razorpay', gatewayPaymentId: refund.payment_id } }) : null;
      if (payment && refund?.amount) {
        await inTx((tx) => refundPayment(tx, systemActor(payment.companyId, payment.createdById ?? ''), payment.id, { amount: fromMinorUnits(refund.amount!), date: today(), reason: `Gateway refund ${refund.id ?? ''}`.trim() }));
        outcome = 'PROCESSED';
      } else outcome = 'UNKNOWN_PAYMENT';
    }
    await prisma.paymentWebhookEvent.update({ where: { id: event.id }, data: { status: outcome, processedAt: new Date(), error: null } });
    res.json({ data: { received: true, outcome } });
  } catch (e) {
    const message = (e as Error).message.slice(0, 500);
    await prisma.paymentWebhookEvent.update({ where: { id: event.id }, data: { status: 'FAILED', error: message } });
    log.error('Webhook processing failed', { eventId, eventType, message });
    // 500 so the gateway redelivers; the FAILED record lets the retry through.
    res.status(500).json({ error: { code: 'WEBHOOK_FAILED', message: 'Webhook could not be processed' } });
  }
}

export const _helpers = { sum, D, zMoneyOptional };
