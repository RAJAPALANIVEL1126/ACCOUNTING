import { Router } from 'express';
import { z } from 'zod';
import { prisma, Prisma } from '../db';
import { parse, zMoneyOptional, zPage, zText } from '../lib/validate';
import { notFound } from '../lib/errors';
import { audit, auditCtx, diff } from '../lib/audit';
import { D, money, ZERO } from '../lib/money';
import { fmtDate, parseDate, today } from '../lib/dates';
import { isValidGstin, isValidPhone } from '../lib/identifiers';
import { companyOf, h, requirePerm } from '../middleware/auth';
import { idempotent } from '../middleware/idempotency';
import { partyBalances, postJournal, systemAccount } from '../services/ledger';
import { actorOf, inTx } from './helpers';

const baseSchema = z.object({
  name: z.string({ required_error: 'Name is required' }).trim().min(2, 'Name is required').max(120),
  businessName: zText(160),
  email: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().toLowerCase().email('Enter a valid email address').optional()),
  phone: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().refine(isValidPhone, 'Enter a valid phone number').optional()),
  address: zText(400),
  gstin: z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() || undefined : v ?? undefined), z.string().refine(isValidGstin, 'Enter a valid 15-character GSTIN').optional()),
});
const createSchema = baseSchema.extend({ openingBalance: zMoneyOptional });
const updateSchema = baseSchema.partial().extend({ isActive: z.boolean().optional() });

/** Customers and suppliers share one implementation; `kind` decides the table and the control account. */
function partyRouter(kind: 'customer' | 'supplier') {
  const router = Router();
  const label = kind === 'customer' ? 'Customer' : 'Supplier';
  const model = (db: Prisma.TransactionClient | typeof prisma) => (kind === 'customer' ? db.customer : db.supplier) as unknown as typeof prisma.customer;
  const idCol = kind === 'customer' ? 'customerId' : 'supplierId';

  router.get('/', requirePerm('contacts.view'), h(async (req, res) => {
    const companyId = companyOf(req);
    const q = parse(zPage.extend({ q: zText(100), includeInactive: z.string().optional(), all: z.string().optional() }), req.query);
    const where = {
      companyId,
      ...(q.includeInactive ? {} : { isActive: true }),
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' as const } }, { businessName: { contains: q.q, mode: 'insensitive' as const } }, { email: { contains: q.q, mode: 'insensitive' as const } }, { phone: { contains: q.q } }] } : {}),
    };
    const [rows, total, balances] = await Promise.all([
      model(prisma).findMany({ where, orderBy: { name: 'asc' }, skip: q.all ? 0 : (q.page - 1) * q.pageSize, take: q.all ? 1000 : q.pageSize }),
      model(prisma).count({ where }),
      partyBalances(prisma, companyId, kind),
    ]);
    res.json({
      data: rows.map((r) => ({ ...r, openingBalance: money(r.openingBalance), outstanding: money(balances.get(r.id) ?? ZERO) })),
      meta: { page: q.page, pageSize: q.pageSize, total, totalOutstanding: money([...balances.values()].reduce((a, b) => a.plus(b), ZERO)) },
    });
  }));

  router.post('/', requirePerm('contacts.manage'), idempotent, h(async (req, res) => {
    const companyId = companyOf(req);
    const d = parse(createSchema, req.body);
    const actor = actorOf(req);
    const party = await inTx(async (tx) => {
      const p = await model(tx).create({
        data: { companyId, name: d.name, businessName: d.businessName ?? null, email: d.email ?? null, phone: d.phone ?? null, address: d.address ?? null, gstin: d.gstin ?? null, openingBalance: d.openingBalance },
      });
      if (d.openingBalance.gt(0)) {
        // An opening balance is a real ledger entry against Opening Balance Equity, never a free-standing number.
        const control = await systemAccount(tx, companyId, kind === 'customer' ? 'RECEIVABLE' : 'PAYABLE');
        const equity = await systemAccount(tx, companyId, 'OPENING_EQUITY');
        await postJournal(tx, {
          companyId, date: parseDate(today()), description: `Opening ${kind === 'customer' ? 'receivable' : 'payable'} — ${p.name}`, createdById: actor.userId,
          lines: kind === 'customer'
            ? [{ accountId: control.id, debit: d.openingBalance, customerId: p.id }, { accountId: equity.id, credit: d.openingBalance }]
            : [{ accountId: equity.id, debit: d.openingBalance }, { accountId: control.id, credit: d.openingBalance, supplierId: p.id }],
        });
      }
      await audit(tx, { ...actor, action: `${kind}.create`, entityType: label, entityId: p.id, summary: `Created ${kind} "${p.name}"${d.openingBalance.gt(0) ? ` with opening balance ${d.openingBalance.toFixed(2)}` : ''}` });
      return p;
    });
    res.status(201).json({ data: { ...party, openingBalance: money(party.openingBalance) } });
  }));

  router.patch('/:id', requirePerm('contacts.manage'), h(async (req, res) => {
    const companyId = companyOf(req);
    const before = await model(prisma).findFirst({ where: { id: req.params.id, companyId } });
    if (!before) throw notFound(label);
    const d = parse(updateSchema, req.body);
    const data: Record<string, unknown> = {};
    for (const k of Object.keys(d) as Array<keyof typeof d>) if (k in req.body) data[k] = d[k] === undefined ? null : d[k];
    if (data.name === null) delete data.name;
    const changes = diff(before as never, data);
    const party = await prisma.$transaction(async (tx) => {
      const p = await model(tx).update({ where: { id: before.id }, data });
      if (Object.keys(changes).length) await audit(tx, { ...auditCtx(req), action: `${kind}.update`, entityType: label, entityId: p.id, summary: `Updated ${kind} "${before.name}": ${Object.keys(changes).join(', ')}` });
      return p;
    });
    res.json({ data: { ...party, openingBalance: money(party.openingBalance) } });
  }));

  router.get('/:id', requirePerm('contacts.view'), h(async (req, res) => {
    const companyId = companyOf(req);
    const p = await model(prisma).findFirst({ where: { id: req.params.id, companyId } });
    if (!p) throw notFound(label);
    const subtype = kind === 'customer' ? 'RECEIVABLE' : 'PAYABLE';
    const col = kind === 'customer' ? Prisma.sql`l."customerId"` : Prisma.sql`l."supplierId"`;
    const signed = kind === 'customer' ? Prisma.sql`l."debit" - l."credit"` : Prisma.sql`l."credit" - l."debit"`;
    const ledger = await prisma.$queryRaw<{ date: Date; doc: string | null; transactionId: string | null; invoiceId: string | null; description: string | null; amount: Prisma.Decimal; balance: Prisma.Decimal }[]>`
      SELECT je."date", COALESCE(t."number", i."number", je."number") AS doc, t."id" AS "transactionId", i."id" AS "invoiceId", je."description",
             ${signed} AS amount, SUM(${signed}) OVER (ORDER BY je."date", je."createdAt", l."id") AS balance
      FROM "JournalEntryLine" l
      JOIN "JournalEntry" je ON je."id" = l."journalEntryId"
      JOIN "Account" a ON a."id" = l."accountId"
      LEFT JOIN "Transaction" t ON t."id" = je."transactionId"
      LEFT JOIN "Invoice" i ON i."id" = je."invoiceId"
      WHERE l."companyId" = ${companyId} AND a."subtype"::text = ${subtype} AND ${col} = ${p.id}
      ORDER BY je."date" DESC, je."createdAt" DESC, l."id" DESC LIMIT 200`;
    const documents = kind === 'customer'
      ? (await prisma.invoice.findMany({ where: { companyId, customerId: p.id, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } }, orderBy: { dueDate: 'asc' }, take: 100 }))
          .map((i) => ({ id: i.id, number: i.number, date: fmtDate(i.issueDate), dueDate: fmtDate(i.dueDate), total: money(i.total), paid: money(i.amountPaid), outstanding: money(i.total.minus(i.amountPaid)) }))
      : (await prisma.transaction.findMany({ where: { companyId, [idCol]: p.id, type: 'EXPENSE', onCredit: true, status: 'POSTED', isReversal: false }, orderBy: { date: 'asc' }, take: 100 }))
          .filter((t) => t.totalAmount.gt(t.amountPaid))
          .map((t) => ({ id: t.id, number: t.number, date: fmtDate(t.date), dueDate: t.dueDate ? fmtDate(t.dueDate) : null, total: money(t.totalAmount), paid: money(t.amountPaid), outstanding: money(t.totalAmount.minus(t.amountPaid)) }));
    const outstanding = (await partyBalances(prisma, companyId, kind)).get(p.id) ?? ZERO;
    res.json({
      data: {
        ...p, openingBalance: money(p.openingBalance), outstanding: money(outstanding), openDocuments: documents,
        ledger: ledger.map((r) => ({ date: fmtDate(r.date), doc: r.doc, transactionId: r.transactionId, invoiceId: r.invoiceId, description: r.description, amount: money(D(r.amount)), balance: money(D(r.balance)) })),
      },
    });
  }));

  return router;
}

export const customersRouter = partyRouter('customer');
export const suppliersRouter = partyRouter('supplier');
