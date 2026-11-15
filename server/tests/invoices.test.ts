import { beforeAll, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import request from 'supertest';
import { app, bootstrapCompany, Client, idem, prisma, resetDb, today } from './helpers';
import { recordPayment } from '../src/services/payments';
import { D } from '../src/lib/money';

type Ctx = Awaited<ReturnType<typeof bootstrapCompany>>;
let c: Ctx;
let admin: Client;
let customerId: string;

const summary = async () => (await admin.get('/api/dashboard/summary')).body.data;
const items = [
  { description: 'Consulting — 10 hours', quantity: '10', unitPrice: '1500.00', discount: '1000.00', taxRate: '18', categoryId: '' },
  { description: 'Training material', quantity: '3', unitPrice: '333.33', taxRate: '0', categoryId: '' },
];
const newInvoice = async (over: Record<string, unknown> = {}) => {
  const res = await admin.post('/api/invoices', { customerId, issueDate: today(), issue: true, items, ...over }, idem());
  expect(res.status).toBe(201);
  return res.body.data as { id: string; number: string; total: string; status: string };
};
const pay = (id: string, body: Record<string, unknown> = {}) => admin.post(`/api/invoices/${id}/payments`, { date: today(), amount: '5000.00', paymentMethod: 'BANK_TRANSFER', accountId: c.bankId, ...body }, idem());
const invoice = async (id: string) => (await admin.get(`/api/invoices/${id}`)).body.data;

beforeAll(async () => {
  await resetDb();
  c = await bootstrapCompany('Invoice Co');
  admin = c.admin;
  items[0].categoryId = c.cat('Consulting Income');
  items[1].categoryId = c.cat('Training Income');
  customerId = (await admin.post('/api/customers', { name: 'Globex Corporation', email: 'ap@globex.example' })).body.data.id;
});

describe('invoice totals', () => {
  it('are calculated on the server, ignoring any totals sent by the client', async () => {
    const res = await admin.post('/api/invoices', { customerId, issueDate: today(), items, total: '1.00', subtotal: '1.00', taxTotal: '0', amountPaid: '999999' }, idem());
    expect(res.status).toBe(201);
    const inv = await invoice(res.body.data.id);
    // 10×1500 = 15000 − 1000 = 14000 (+18% = 2520) ; 3×333.33 = 999.99
    expect(inv.subtotal).toBe('15999.99');
    expect(inv.discountTotal).toBe('1000.00');
    expect(inv.taxTotal).toBe('2520.00');
    expect(inv.total).toBe('17519.99');
    expect(inv.amountPaid).toBe('0.00');
    expect(inv.status).toBe('DRAFT');
    expect(inv.items[0].lineTotal).toBe('16520.00');
  });

  it('validates line items', async () => {
    const bad = (item: Record<string, unknown>) => admin.post('/api/invoices', { customerId, issueDate: today(), items: [{ ...items[0], ...item }] });
    expect((await bad({ quantity: '0' })).status).toBe(400);
    expect((await bad({ quantity: '-1' })).status).toBe(400);
    expect((await bad({ unitPrice: '-5' })).status).toBe(400);
    expect((await bad({ taxRate: '150' })).status).toBe(400);
    expect((await bad({ discount: '999999' })).status).toBe(400);
    expect((await bad({ categoryId: c.cat('Rent') })).status).toBe(400); // expense category
    expect((await admin.post('/api/invoices', { customerId, issueDate: today(), items: [] })).status).toBe(400);
    expect((await admin.post('/api/invoices', { customerId, issueDate: today(), dueDate: '2000-01-01', items })).status).toBe(400);
  });

  it('a draft affects nothing; issuing recognises revenue and a receivable once', async () => {
    const before = await summary();
    const draft = await admin.post('/api/invoices', { customerId, issueDate: today(), items }, idem());
    expect((await summary()).totalIncome).toBe(before.totalIncome);
    expect((await summary()).receivables).toBe(before.receivables);

    const issued = await admin.post(`/api/invoices/${draft.body.data.id}/issue`);
    expect(issued.status).toBe(200);
    const after = await summary();
    expect(Number(after.totalIncome) - Number(before.totalIncome)).toBeCloseTo(14999.99, 2); // net of tax
    expect(Number(after.receivables) - Number(before.receivables)).toBeCloseTo(17519.99, 2); // gross
    expect((await admin.post(`/api/invoices/${draft.body.data.id}/issue`)).status).toBe(422); // not twice
    expect((await admin.patch(`/api/invoices/${draft.body.data.id}`, { customerId, issueDate: today(), items })).status).toBe(422); // issued = locked
  });
});

describe('payment allocation', () => {
  it('partial then full payment: statuses, balances and no double-counted revenue', async () => {
    const inv = await newInvoice();
    const s0 = await summary();

    const p1 = await pay(inv.id, { amount: '5000.00' });
    expect(p1.status).toBe(201);
    let cur = await invoice(inv.id);
    expect(cur.status).toBe('PARTIALLY_PAID');
    expect(cur.amountPaid).toBe('5000.00');
    expect(cur.outstanding).toBe('12519.99');

    const s1 = await summary();
    expect(s1.totalIncome).toBe(s0.totalIncome); // receiving money is not new revenue
    expect(Number(s1.bankBalance) - Number(s0.bankBalance)).toBeCloseTo(5000, 2);
    expect(Number(s0.receivables) - Number(s1.receivables)).toBeCloseTo(5000, 2);

    const p2 = await pay(inv.id, { amount: '12519.99', paymentMethod: 'UPI', gatewayPaymentId: 'UPI-0001' });
    expect(p2.status).toBe(201);
    cur = await invoice(inv.id);
    expect(cur.status).toBe('PAID');
    expect(cur.outstanding).toBe('0.00');
    expect(cur.payments).toHaveLength(2);
    expect((await summary()).totalIncome).toBe(s0.totalIncome);

    const allocated = await prisma.paymentAllocation.aggregate({ where: { invoiceId: inv.id }, _sum: { amount: true } });
    expect(allocated._sum.amount!.toFixed(2)).toBe(inv.total === '17519.99' ? '17519.99' : cur.total);
  });

  it('rejects overpayment and payments on drafts or settled invoices', async () => {
    const inv = await newInvoice();
    const over = await pay(inv.id, { amount: '17520.00' });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('OVERPAYMENT');
    expect((await pay(inv.id, { amount: '0' })).status).toBe(400);
    expect((await pay(inv.id, { amount: '-10' })).status).toBe(400);
    await pay(inv.id, { amount: '17519.99' });
    expect((await pay(inv.id, { amount: '0.01' })).status).toBe(422);
    const draft = await admin.post('/api/invoices', { customerId, issueDate: today(), items }, idem());
    expect((await pay(draft.body.data.id, { amount: '1' })).status).toBe(422);
  });

  it('concurrent payments can never over-settle an invoice', async () => {
    const inv = await newInvoice(); // 17519.99
    const results = await Promise.all(Array.from({ length: 5 }, () => pay(inv.id, { amount: '6000.00' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2); // 12000 fits, a third 6000 does not
    expect(results.filter((r) => r.status === 422)).toHaveLength(3);
    const cur = await invoice(inv.id);
    expect(cur.amountPaid).toBe('12000.00');
    expect(cur.status).toBe('PARTIALLY_PAID');
  });
});

describe('duplicate payment prevention', () => {
  it('a gateway reference can only be recorded once', async () => {
    const inv = await newInvoice();
    const first = await pay(inv.id, { amount: '100.00', paymentMethod: 'UPI', gatewayPaymentId: 'UPI-DUP-77' });
    expect(first.status).toBe(201);
    const dup = await pay(inv.id, { amount: '100.00', paymentMethod: 'UPI', gatewayPaymentId: 'UPI-DUP-77' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_PAYMENT');
    expect((await invoice(inv.id)).amountPaid).toBe('100.00');
  });

  it('a double-clicked payment (same Idempotency-Key) posts once', async () => {
    const inv = await newInvoice();
    const key = idem();
    const body = { date: today(), amount: '700.00', paymentMethod: 'BANK_TRANSFER', accountId: c.bankId };
    const [r1, r2] = await Promise.all([admin.post(`/api/invoices/${inv.id}/payments`, body, key), admin.post(`/api/invoices/${inv.id}/payments`, body, key)]);
    expect([r1.status, r2.status].filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    const replay = await admin.post(`/api/invoices/${inv.id}/payments`, body, key);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect((await invoice(inv.id)).amountPaid).toBe('700.00');
  });
});

describe('refunds and reversals', () => {
  it('a partial refund reopens the invoice by exactly the refunded amount', async () => {
    const inv = await newInvoice();
    const p = (await pay(inv.id, { amount: '17519.99' })).body.data;
    const bank0 = Number((await summary()).bankBalance);

    expect((await admin.post(`/api/payments/${p.id}/refund`, { amount: '99999', date: today(), reason: 'Too much to refund' })).status).toBe(422);
    expect((await admin.post(`/api/payments/${p.id}/refund`, { amount: '500', date: today() })).status).toBe(400); // reason required
    const r = await admin.post(`/api/payments/${p.id}/refund`, { amount: '2519.99', date: today(), reason: 'Goodwill credit for delay' }, idem());
    expect(r.status).toBe(201);
    expect(r.body.data.refundStatus).toBe('PARTIAL');
    expect(r.body.data.refundedAmount).toBe('2519.99');

    const cur = await invoice(inv.id);
    expect(cur.status).toBe('PARTIALLY_PAID');
    expect(cur.amountPaid).toBe('15000.00');
    expect(Number((await summary()).bankBalance)).toBeCloseTo(bank0 - 2519.99, 2);

    const full = await admin.post(`/api/payments/${p.id}/refund`, { amount: '15000.00', date: today(), reason: 'Order cancelled by customer' }, idem());
    expect(full.body.data.refundStatus).toBe('FULL');
    expect((await invoice(inv.id)).status).toBe('ISSUED');
    expect((await admin.post(`/api/payments/${p.id}/refund`, { amount: '0.01', date: today(), reason: 'Nothing left to refund' })).status).toBe(422);
  });

  it('reversing a receipt releases the invoice and marks the payment reversed', async () => {
    const inv = await newInvoice();
    const p = (await pay(inv.id, { amount: '17519.99' })).body.data;
    expect((await invoice(inv.id)).status).toBe('PAID');
    const rev = await admin.post(`/api/transactions/${p.transactionId}/reverse`, { reason: 'Cheque bounced at the bank' });
    expect(rev.status).toBe(201);
    const cur = await invoice(inv.id);
    expect(cur.status).toBe('ISSUED');
    expect(cur.amountPaid).toBe('0.00');
    expect(cur.payments[0].status).toBe('REVERSED');
  });

  it('an invoice with payments cannot be cancelled; an unpaid one reverses its revenue', async () => {
    const paid = await newInvoice();
    await pay(paid.id, { amount: '10.00' });
    expect((await admin.post(`/api/invoices/${paid.id}/cancel`, { reason: 'Trying to cancel a paid invoice' })).status).toBe(422);

    const before = await summary();
    const inv = await newInvoice();
    const mid = await summary();
    expect(Number(mid.totalIncome) - Number(before.totalIncome)).toBeCloseTo(14999.99, 2);
    const cancel = await admin.post(`/api/invoices/${inv.id}/cancel`, { reason: 'Raised in error for this customer' });
    expect(cancel.status).toBe(200);
    const after = await summary();
    expect(after.totalIncome).toBe(before.totalIncome);
    expect(after.receivables).toBe(before.receivables);
    expect((await invoice(inv.id)).status).toBe('CANCELLED');
  });
});

describe('online payments in recording mode', () => {
  it('a pending payment posts nothing until it is confirmed', async () => {
    const inv = await newInvoice();
    const s0 = await summary();
    const res = await admin.post('/api/payments', { direction: 'INBOUND', status: 'PENDING', method: 'NET_BANKING', invoiceId: inv.id, accountId: c.bankId, date: today(), amount: '4000.00', gateway: 'BillDesk', fee: '40.00' }, idem());
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING');
    const s1 = await summary();
    expect(s1.bankBalance).toBe(s0.bankBalance);
    expect(Number(s1.pendingPayments) - Number(s0.pendingPayments)).toBeCloseTo(4000, 2);
    expect((await invoice(inv.id)).amountPaid).toBe('0.00');

    const done = await admin.post(`/api/payments/${res.body.data.id}/status`, { status: 'SUCCESS', gatewayPaymentId: 'BD-998877' });
    expect(done.status).toBe(200);
    const s2 = await summary();
    expect(Number(s2.bankBalance) - Number(s0.bankBalance)).toBeCloseTo(3960, 2); // net of the 40.00 fee
    expect(Number(s2.totalExpenses) - Number(s0.totalExpenses)).toBeCloseTo(40, 2); // fee is an expense
    expect((await invoice(inv.id)).amountPaid).toBe('4000.00'); // the customer is credited the gross amount

    // Confirming again is a no-op, not a second posting.
    expect((await admin.post(`/api/payments/${res.body.data.id}/status`, { status: 'SUCCESS' })).status).toBe(200);
    expect((await invoice(inv.id)).amountPaid).toBe('4000.00');
    expect((await admin.post(`/api/payments/${res.body.data.id}/status`, { status: 'FAILED' })).status).toBe(422);
  });

  it('a failed payment never reaches the ledger', async () => {
    const inv = await newInvoice();
    const s0 = await summary();
    const res = await admin.post('/api/payments', { status: 'PENDING', method: 'CREDIT_CARD', invoiceId: inv.id, accountId: c.bankId, date: today(), amount: '100.00' }, idem());
    expect((await admin.post(`/api/payments/${res.body.data.id}/status`, { status: 'FAILED', note: 'Card declined' })).status).toBe(200);
    expect((await summary()).bankBalance).toBe(s0.bankBalance);
    expect((await admin.post(`/api/payments/${res.body.data.id}/status`, { status: 'SUCCESS' })).status).toBe(422);
  });

  it('reports recording mode honestly and can reconcile payments', async () => {
    const list = await admin.get('/api/payments?online=1');
    expect(list.status).toBe(200);
    expect(list.body.meta.gateway).toHaveProperty('mode');
    const ok = list.body.data.find((p: { status: string }) => p.status === 'SUCCESS');
    const rec = await admin.post(`/api/payments/${ok.id}/reconcile`, { reconciled: true });
    expect(rec.body.data.reconStatus).toBe('RECONCILED');
    expect((await admin.get('/api/payments?recon=RECONCILED')).body.data.map((p: { id: string }) => p.id)).toContain(ok.id);
  });

  it('never accepts card data', async () => {
    const res = await admin.post('/api/payments', { status: 'SUCCESS', method: 'CREDIT_CARD', categoryId: c.cat('Product Sales'), accountId: c.bankId, date: today(), amount: '10.00', cardNumber: '4111111111111111', cvv: '123' }, idem());
    expect(res.status).toBe(201);
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(JSON.stringify(row)).not.toMatch(/4111|cvv/i);
  });
});

describe('payment webhook verification', () => {
  const SECRET = 'unit-test-webhook-secret';
  const sign = (raw: string, secret = SECRET) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const post = (raw: string, signature: string | null, eventId?: string) => {
    let r = request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json');
    if (signature !== null) r = r.set('X-Razorpay-Signature', signature);
    if (eventId) r = r.set('X-Razorpay-Event-Id', eventId);
    return r.send(raw);
  };
  const pendingGatewayPayment = async (invoiceId: string, amount: string, orderId: string) =>
    prisma.$transaction((tx) => recordPayment(tx, { companyId: c.companyId, userId: admin.user!.id }, {
      direction: 'INBOUND', status: 'PENDING', method: 'PAYMENT_GATEWAY', gateway: 'razorpay', gatewayOrderId: orderId, invoiceId, accountId: c.bankId, date: today(), amount: D(amount), fee: D(0),
    }));
  const captured = (orderId: string, paymentId: string, amountPaise: number) => JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: orderId, amount: amountPaise, method: 'upi', fee: 2360 } } } });

  it('rejects unsigned, wrongly signed and tampered payloads', async () => {
    const inv = await newInvoice();
    const p = await pendingGatewayPayment(inv.id, '1000.00', 'order_bad_1');
    const raw = captured('order_bad_1', 'pay_bad_1', 100000);
    expect((await post(raw, null)).status).toBe(400);
    expect((await post(raw, 'deadbeef')).status).toBe(400);
    expect((await post(raw, sign(raw, 'attacker-secret'))).status).toBe(400);
    expect((await post(raw.replace('100000', '100'), sign(raw))).status).toBe(400); // body changed after signing
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('PENDING');
    expect((await invoice(inv.id)).amountPaid).toBe('0.00');
  });

  it('a browser cannot mark a gateway payment as paid', async () => {
    const inv = await newInvoice();
    const p = await pendingGatewayPayment(inv.id, '1000.00', 'order_client_1');
    const r = await admin.post(`/api/payments/${p.id}/status`, { status: 'SUCCESS', gatewayPaymentId: 'pay_fake' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('GATEWAY_MANAGED');
    expect((await invoice(inv.id)).amountPaid).toBe('0.00');
  });

  it('a valid webhook settles the payment once; redeliveries are ignored', async () => {
    const inv = await newInvoice();
    const p = await pendingGatewayPayment(inv.id, '1000.00', 'order_ok_1');
    const raw = captured('order_ok_1', 'pay_ok_1', 100000);
    const first = await post(raw, sign(raw), 'evt_ok_1');
    expect(first.status).toBe(200);
    expect(first.body.data.outcome).toBe('PROCESSED');
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.status).toBe('SUCCESS');
    expect(row.gatewayPaymentId).toBe('pay_ok_1');
    expect(row.method).toBe('UPI');
    expect(row.fee.toFixed(2)).toBe('23.60'); // 2360 paise
    expect((await invoice(inv.id)).amountPaid).toBe('1000.00');

    const again = await post(raw, sign(raw), 'evt_ok_1');
    expect(again.status).toBe(200);
    expect(again.body.data.duplicate).toBe(true);
    // Same payment reported under a new event id must still not post twice.
    const other = await post(raw, sign(raw), 'evt_ok_2');
    expect(other.status).toBe(200);
    expect((await invoice(inv.id)).amountPaid).toBe('1000.00');
    expect(await prisma.paymentAllocation.count({ where: { paymentId: p.id } })).toBe(1);
    expect(await prisma.paymentWebhookEvent.count({ where: { eventId: 'evt_ok_1' } })).toBe(1);
  });

  it('refuses a captured amount that differs from the expected amount', async () => {
    const inv = await newInvoice();
    const p = await pendingGatewayPayment(inv.id, '1000.00', 'order_amt_1');
    const raw = captured('order_amt_1', 'pay_amt_1', 100); // ₹1 instead of ₹1000
    const r = await post(raw, sign(raw), 'evt_amt_1');
    expect(r.status).toBe(500);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('PENDING');
    expect((await prisma.paymentWebhookEvent.findFirstOrThrow({ where: { eventId: 'evt_amt_1' } })).status).toBe('FAILED');
  });

  it('marks failed gateway payments and ignores unknown orders', async () => {
    const inv = await newInvoice();
    const p = await pendingGatewayPayment(inv.id, '500.00', 'order_fail_1');
    const raw = JSON.stringify({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_f', order_id: 'order_fail_1', amount: 50000 } } } });
    expect((await post(raw, sign(raw), 'evt_fail_1')).status).toBe(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('FAILED');
    const unknown = captured('order_does_not_exist', 'pay_x', 100);
    const r = await post(unknown, sign(unknown), 'evt_unknown_1');
    expect(r.status).toBe(200);
    expect(r.body.data.outcome).toBe('UNKNOWN_ORDER');
  });
});

describe('supplier bills', () => {
  it('a credit expense creates a payable; paying it clears the payable without a second expense', async () => {
    const supplierId = (await admin.post('/api/suppliers', { name: 'Paper Mills Ltd' })).body.data.id;
    const s0 = await summary();
    const bill = await admin.post('/api/expenses', { date: today(), categoryId: c.cat('Office and Administrative'), supplierId, amount: '2000.00', taxAmount: '360.00', paymentMethod: 'CREDIT', description: 'Stationery' }, idem());
    expect(bill.status).toBe(201);
    const s1 = await summary();
    expect(Number(s1.payables) - Number(s0.payables)).toBeCloseTo(2360, 2);
    expect(Number(s1.totalExpenses) - Number(s0.totalExpenses)).toBeCloseTo(2360, 2); // tax not marked recoverable → part of cost
    expect(s1.bankBalance).toBe(s0.bankBalance);

    expect((await admin.post(`/api/expenses/${bill.body.data.id}/payments`, { date: today(), amount: '5000', paymentMethod: 'BANK_TRANSFER', accountId: c.bankId })).status).toBe(422);
    const paid = await admin.post(`/api/expenses/${bill.body.data.id}/payments`, { date: today(), amount: '2360.00', paymentMethod: 'BANK_TRANSFER', accountId: c.bankId }, idem());
    expect(paid.status).toBe(201);
    const s2 = await summary();
    expect(s2.payables).toBe(s0.payables);
    expect(s2.totalExpenses).toBe(s1.totalExpenses);
    expect(Number(s1.bankBalance) - Number(s2.bankBalance)).toBeCloseTo(2360, 2);
    expect((await admin.post(`/api/transactions/${bill.body.data.id}/reverse`, { reason: 'Bill has payments against it' })).status).toBe(422);
    expect((await admin.post('/api/expenses', { date: today(), categoryId: c.cat('Rent'), amount: '10', paymentMethod: 'CREDIT' })).status).toBe(400); // credit needs a supplier
  });

  it('recoverable input tax is kept out of expenses', async () => {
    const supplierId = (await admin.post('/api/suppliers', { name: 'Tech Hardware' })).body.data.id;
    const s0 = await summary();
    await admin.post('/api/expenses', { date: today(), categoryId: c.cat('Office and Administrative'), supplierId, amount: '1000.00', taxAmount: '180.00', taxRecoverable: true, paymentMethod: 'CREDIT' }, idem());
    const s1 = await summary();
    expect(Number(s1.totalExpenses) - Number(s0.totalExpenses)).toBeCloseTo(1000, 2);
    const tax = (await admin.get(`/api/reports/tax-summary?from=${today()}&to=${today()}`)).body.data;
    expect(Number(tax.totals.inp)).toBeGreaterThanOrEqual(180);
  });
});

describe('invoice PDF', () => {
  it('renders a PDF document', async () => {
    const inv = await newInvoice();
    const res = await admin.get(`/api/invoices/${inv.id}/pdf`).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (d: Buffer) => chunks.push(d)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((res.body as Buffer).length).toBeGreaterThan(1000);
  });
});
