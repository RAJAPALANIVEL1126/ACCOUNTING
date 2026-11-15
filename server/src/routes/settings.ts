import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { config } from '../config';
import { parse, zText } from '../lib/validate';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { audit, auditCtx, diff } from '../lib/audit';
import { mailConfigured } from '../lib/mailer';
import { companyOf, h, requirePerm } from '../middleware/auth';
import { gatewayStatus } from '../services/gateway';

export const settingsRouter = Router();
export const categoriesRouter = Router();
export const taxRatesRouter = Router();

settingsRouter.get('/', requirePerm('company.view'), h(async (req, res) => {
  const settings = await prisma.companySettings.findUnique({ where: { companyId: companyOf(req) } });
  res.json({
    data: {
      settings,
      gateway: gatewayStatus(),
      security: {
        passwordMinLength: config.security.passwordMinLength,
        maxFailedLogins: config.security.maxFailedLogins,
        lockMinutes: config.security.lockMinutes,
        sessionTtlHours: config.sessionTtlHours,
        secureCookies: config.cookieSecure,
        emailConfigured: mailConfigured(),
      },
    },
  });
}));

const settingsSchema = z.object({
  accountingMethod: z.enum(['ACCRUAL', 'CASH']).optional(),
  expenseApprovalRequired: z.boolean().optional(),
  allowSelfApproval: z.boolean().optional(),
  taxEnabled: z.boolean().optional(),
  taxLabel: z.string().trim().min(1).max(20).optional(),
  invoicePrefix: z.string().trim().max(12).regex(/^[A-Za-z0-9/-]*$/, 'Use letters, digits, "-" or "/"').optional(),
  invoiceDueDays: z.coerce.number().int().min(0).max(365).optional(),
  invoiceNotes: zText(1000),
  invoiceTerms: zText(2000),
  notifyExpenseApproval: z.boolean().optional(),
  notifyPaymentReceived: z.boolean().optional(),
});

settingsRouter.patch('/', requirePerm('settings.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const d = parse(settingsSchema, req.body);
  const before = await prisma.companySettings.findUniqueOrThrow({ where: { companyId } });
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (k in req.body) data[k] = v === undefined ? null : v;
  const changes = diff(before as never, data);
  const settings = await prisma.$transaction(async (tx) => {
    const s = await tx.companySettings.update({ where: { companyId }, data });
    if (Object.keys(changes).length) {
      await audit(tx, { ...auditCtx(req), action: 'settings.update', entityType: 'CompanySettings', entityId: s.id, summary: `Changed settings: ${Object.entries(changes).map(([k, c]) => `${k} (${String(c.from)} → ${String(c.to)})`).join(', ')}`.slice(0, 900), metadata: { changes } });
    }
    return s;
  });
  res.json({ data: settings });
}));

// ───────────────────────── Categories ─────────────────────────

const INCOME_GROUPS = ['SALES_REVENUE', 'OTHER_OPERATING_INCOME'];
const EXPENSE_GROUPS = ['DIRECT_COST', 'COST_OF_GOODS_SOLD', 'EMPLOYEE', 'RENT_UTILITIES', 'MARKETING', 'TRANSPORTATION', 'ADMINISTRATIVE', 'OTHER_EXPENSE'];
const categorySchema = z
  .object({
    name: z.string({ required_error: 'Name is required' }).trim().min(2, 'Name is required').max(80),
    type: z.enum(['INCOME', 'EXPENSE']),
    plGroup: z.enum([...INCOME_GROUPS, ...EXPENSE_GROUPS] as [string, ...string[]]),
  })
  .refine((d) => (d.type === 'INCOME' ? INCOME_GROUPS : EXPENSE_GROUPS).includes(d.plGroup), { path: ['plGroup'], message: 'Choose a report group that matches the category type' });

categoriesRouter.get('/', requirePerm('transactions.view'), h(async (req, res) => {
  const q = parse(z.object({ type: z.enum(['INCOME', 'EXPENSE']).optional(), includeInactive: z.string().optional() }), req.query);
  const data = await prisma.transactionCategory.findMany({
    where: { companyId: companyOf(req), ...(q.type ? { type: q.type } : {}), ...(q.includeInactive ? {} : { isActive: true }) },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  });
  res.json({ data });
}));

categoriesRouter.post('/', requirePerm('categories.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const d = parse(categorySchema, req.body);
  if (await prisma.transactionCategory.findFirst({ where: { companyId, type: d.type, name: { equals: d.name, mode: 'insensitive' } } })) {
    throw conflict('A category with this name already exists');
  }
  const c = await prisma.transactionCategory.create({ data: { companyId, name: d.name, type: d.type, plGroup: d.plGroup as never } });
  await audit(prisma, { ...auditCtx(req), action: 'category.create', entityType: 'TransactionCategory', entityId: c.id, summary: `Created ${d.type.toLowerCase()} category "${c.name}"` });
  res.status(201).json({ data: c });
}));

categoriesRouter.patch('/:id', requirePerm('categories.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const cat = await prisma.transactionCategory.findFirst({ where: { id: req.params.id, companyId } });
  if (!cat) throw notFound('Category');
  if (cat.isSystem) throw unprocessable('System categories cannot be changed');
  const d = parse(z.object({ name: z.string().trim().min(2).max(80).optional(), plGroup: z.string().optional(), isActive: z.boolean().optional() }), req.body);
  if (d.plGroup && !(cat.type === 'INCOME' ? INCOME_GROUPS : EXPENSE_GROUPS).includes(d.plGroup)) throw unprocessable('Choose a report group that matches the category type');
  if (d.name && d.name.toLowerCase() !== cat.name.toLowerCase() && (await prisma.transactionCategory.findFirst({ where: { companyId, type: cat.type, name: { equals: d.name, mode: 'insensitive' } } }))) {
    throw conflict('A category with this name already exists');
  }
  const c = await prisma.transactionCategory.update({ where: { id: cat.id }, data: { name: d.name ?? cat.name, plGroup: (d.plGroup as never) ?? cat.plGroup, isActive: d.isActive ?? cat.isActive } });
  await audit(prisma, { ...auditCtx(req), action: 'category.update', entityType: 'TransactionCategory', entityId: c.id, summary: `Updated category "${cat.name}"`, metadata: { changes: diff(cat as never, d) } });
  res.json({ data: c });
}));

// ───────────────────────── Tax rates ─────────────────────────

const taxSchema = z.object({
  name: z.string({ required_error: 'Name is required' }).trim().min(1, 'Name is required').max(40),
  rate: z.coerce.number({ invalid_type_error: 'Enter a rate' }).min(0, 'Rate cannot be negative').max(100, 'Rate cannot exceed 100').refine((n) => Math.round(n * 100) === n * 100 || Number.isInteger(n * 100), 'Use at most 2 decimals'),
});

taxRatesRouter.get('/', requirePerm('transactions.view'), h(async (req, res) => {
  res.json({ data: await prisma.taxRate.findMany({ where: { companyId: companyOf(req) }, orderBy: { rate: 'asc' } }) });
}));

taxRatesRouter.post('/', requirePerm('settings.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const d = parse(taxSchema, req.body);
  if (await prisma.taxRate.findFirst({ where: { companyId, name: { equals: d.name, mode: 'insensitive' } } })) throw conflict('A tax rate with this name already exists');
  const t = await prisma.taxRate.create({ data: { companyId, name: d.name, rate: d.rate.toFixed(2) } });
  await audit(prisma, { ...auditCtx(req), action: 'tax_rate.create', entityType: 'TaxRate', entityId: t.id, summary: `Created tax rate "${t.name}" at ${t.rate.toFixed(2)}%` });
  res.status(201).json({ data: t });
}));

taxRatesRouter.patch('/:id', requirePerm('settings.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const rate = await prisma.taxRate.findFirst({ where: { id: req.params.id, companyId } });
  if (!rate) throw notFound('Tax rate');
  const d = parse(z.object({ isActive: z.boolean() }), req.body);
  const t = await prisma.taxRate.update({ where: { id: rate.id }, data: { isActive: d.isActive } });
  await audit(prisma, { ...auditCtx(req), action: 'tax_rate.update', entityType: 'TaxRate', entityId: t.id, summary: `${d.isActive ? 'Activated' : 'Deactivated'} tax rate "${t.name}"` });
  res.json({ data: t });
}));
