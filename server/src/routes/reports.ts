import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { parse, zIdOptional, zText } from '../lib/validate';
import { forbidden } from '../lib/errors';
import { audit, auditCtx } from '../lib/audit';
import { can, companyOf, h, requirePerm } from '../middleware/auth';
import { buildReport, REPORTS } from '../services/reports';
import { sendReport } from '../services/exporter';
import { rangeOf } from './helpers';

export const reportsRouter = Router();
export const auditRouter = Router();

reportsRouter.get('/', requirePerm('reports.view'), h(async (_req, res) => {
  res.json({ data: Object.entries(REPORTS).map(([key, r]) => ({ key, ...r })) });
}));

reportsRouter.get('/:key', requirePerm('reports.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const q = parse(z.object({
    format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json'),
    categoryId: zIdOptional, accountId: zIdOptional, customerId: zIdOptional, supplierId: zIdOptional,
    paymentMethod: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['CASH', 'BANK_TRANSFER', 'UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'PAYMENT_GATEWAY', 'CHEQUE', 'CREDIT', 'OTHER']).optional()),
    q: zText(100), compare: z.string().optional(),
  }), req.query);
  if (q.format !== 'json' && !can(req, 'reports.export')) throw forbidden('You do not have permission to export reports');
  const report = await buildReport(companyId, req.params.key, { ...rangeOf(req), ...q, compare: q.compare === '1' || q.compare === 'true' });
  if (q.format !== 'json') {
    await audit(prisma, { ...auditCtx(req), action: 'export', entityType: 'Report', entityId: report.key, summary: `Exported "${report.title}" as ${q.format.toUpperCase()} (${report.meta.asOf ?? `${report.meta.from} to ${report.meta.to}`})` });
  }
  await sendReport(res, report, q.format);
}));

// Read-only by design: there is no route that edits or deletes audit records, and the database rejects it too.
auditRouter.get('/', requirePerm('audit.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const q = parse(z.object({
    page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50),
    userId: zIdOptional, entityType: zText(40), action: zText(60), q: zText(100),
    from: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
    to: z.preprocess((v) => (v === '' ? undefined : v), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()),
  }), req.query);
  const where = {
    companyId,
    ...(q.userId ? { userId: q.userId } : {}),
    ...(q.entityType ? { entityType: q.entityType } : {}),
    ...(q.action ? { action: { startsWith: q.action } } : {}),
    ...(q.q ? { summary: { contains: q.q, mode: 'insensitive' as const } } : {}),
    ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from + 'T00:00:00') } : {}), ...(q.to ? { lte: new Date(q.to + 'T23:59:59.999') } : {}) } } : {}),
  };
  const [rows, total, entityTypes] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where: { companyId }, distinct: ['entityType'], select: { entityType: true }, orderBy: { entityType: 'asc' } }),
  ]);
  res.json({ data: rows, meta: { page: q.page, pageSize: q.pageSize, total, entityTypes: entityTypes.map((e) => e.entityType) } });
}));
