import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { parse, zText } from '../lib/validate';
import { AppError, conflict, forbidden, notFound } from '../lib/errors';
import { audit, auditCtx, diff } from '../lib/audit';
import { isValidGstin, isValidIndianPin, isValidPan, isValidPhone, panFromGstin } from '../lib/identifiers';
import { companyOf, h, requireAuth, requirePerm } from '../middleware/auth';
import { provisionCompanyDefaults } from '../services/reference';
import { saveUpload, uploadSingle, sendAttachment } from './attachments';

export const companyRouter = Router();

const upper = (max: number) => z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() || undefined : v ?? undefined), z.string().max(max).optional());

export const companySchema = z
  .object({
    name: z.string({ required_error: 'Company name is required' }).trim().min(2, 'Company name is required').max(160),
    registrationNumber: zText(60),
    gstin: upper(15),
    pan: upper(10),
    email: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().toLowerCase().email('Enter a valid email address').optional()),
    phone: zText(25),
    address: zText(400),
    city: zText(80),
    state: zText(80),
    country: z.string().trim().min(2).max(80).default('India'),
    postalCode: zText(12),
    website: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().url('Enter a full URL, e.g. https://example.com').max(200).optional()),
    baseCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code, e.g. INR').default('INR'),
    fyStartMonth: z.coerce.number().int().min(1).max(12).default(4),
  })
  .superRefine((d, ctx) => {
    if (d.gstin && !isValidGstin(d.gstin)) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'Enter a valid 15-character GSTIN' });
    if (d.pan && !isValidPan(d.pan)) ctx.addIssue({ code: 'custom', path: ['pan'], message: 'Enter a valid 10-character PAN' });
    if (d.gstin && d.pan && isValidGstin(d.gstin) && isValidPan(d.pan) && panFromGstin(d.gstin) !== d.pan) {
      ctx.addIssue({ code: 'custom', path: ['pan'], message: 'PAN does not match the PAN embedded in the GSTIN' });
    }
    if (d.phone && !isValidPhone(d.phone)) ctx.addIssue({ code: 'custom', path: ['phone'], message: 'Enter a valid phone number' });
    if (d.postalCode && d.country.toLowerCase() === 'india' && !isValidIndianPin(d.postalCode)) {
      ctx.addIssue({ code: 'custom', path: ['postalCode'], message: 'Enter a valid 6-digit PIN code' });
    }
  });

const nullable = <T extends Record<string, unknown>>(d: T) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v === undefined ? null : v])) as T;

companyRouter.get('/', requireAuth, h(async (req, res) => {
  const id = req.auth!.companyId;
  if (!id) return res.json({ data: null });
  if (!req.auth!.permissions.has('company.view')) throw forbidden();
  res.json({ data: await prisma.company.findUnique({ where: { id } }) });
}));

// First-run only: the setup-created SUPER_ADMIN creates their company. Nobody else can create one.
companyRouter.post('/', requireAuth, h(async (req, res) => {
  const a = req.auth!;
  if (a.role !== 'SUPER_ADMIN') throw forbidden('Only a super administrator can create a company');
  if (a.companyId) throw conflict('Your account already belongs to a company. Edit it instead.');
  const d = parse(companySchema, req.body);
  const company = await prisma.$transaction(async (tx) => {
    // Re-check under lock so two concurrent requests cannot create two companies for one admin.
    const rows = await tx.$queryRaw<{ companyId: string | null }[]>`SELECT "companyId" FROM "User" WHERE "id" = ${a.userId} FOR UPDATE`;
    if (rows[0]?.companyId) throw conflict('Your account already belongs to a company.');
    const c = await tx.company.create({ data: nullable(d) as never });
    await provisionCompanyDefaults(tx, c.id);
    await tx.user.update({ where: { id: a.userId }, data: { companyId: c.id } });
    await audit(tx, { ...auditCtx(req), companyId: c.id, action: 'company.create', entityType: 'Company', entityId: c.id, summary: `Created company "${c.name}"` });
    return c;
  });
  res.status(201).json({ data: company });
}));

companyRouter.patch('/', requirePerm('company.manage'), h(async (req, res) => {
  const id = companyOf(req);
  const before = await prisma.company.findUnique({ where: { id } });
  if (!before) throw notFound('Company');
  const d = parse(companySchema, { ...before, ...req.body });
  if (d.baseCurrency !== before.baseCurrency && (await prisma.journalEntry.count({ where: { companyId: id } })) > 0) {
    throw new AppError(422, 'CURRENCY_LOCKED', 'The base currency cannot be changed once accounting entries exist', { fields: { baseCurrency: 'Locked: accounting entries exist' } });
  }
  const data = nullable(d);
  const changes = diff(before as never, data);
  const company = await prisma.$transaction(async (tx) => {
    const c = await tx.company.update({ where: { id }, data: data as never });
    if (Object.keys(changes).length) {
      await audit(tx, { ...auditCtx(req), action: 'company.update', entityType: 'Company', entityId: id, summary: `Updated company details: ${Object.keys(changes).join(', ')}`, metadata: { changes } });
    }
    return c;
  });
  res.json({ data: company });
}));

companyRouter.post('/logo', requirePerm('company.manage'), uploadSingle, h(async (req, res) => {
  const id = companyOf(req);
  const att = await saveUpload(req, 'logo', ['image/png', 'image/jpeg', 'image/webp']);
  await prisma.company.update({ where: { id }, data: { logoAttachmentId: att.id } });
  await audit(prisma, { ...auditCtx(req), action: 'company.logo', entityType: 'Company', entityId: id, summary: `Updated company logo (${att.fileName})` });
  res.status(201).json({ data: { logoAttachmentId: att.id } });
}));

companyRouter.get('/logo', requirePerm('company.view'), h(async (req, res) => {
  const c = await prisma.company.findUnique({ where: { id: companyOf(req) }, select: { logoAttachmentId: true } });
  if (!c?.logoAttachmentId) throw notFound('Logo');
  await sendAttachment(res, companyOf(req), c.logoAttachmentId, true);
}));
