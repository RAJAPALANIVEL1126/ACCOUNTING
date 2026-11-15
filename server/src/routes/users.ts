import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { User, Role } from '@prisma/client';
import { prisma } from '../db';
import { parse, zText } from '../lib/validate';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { audit, auditCtx } from '../lib/audit';
import { ADMIN_ROLES, PERMISSIONS, ROLE_DESCRIPTIONS, ROLE_NAMES, ROLE_PERMISSIONS } from '../lib/permissions';
import { isValidPhone } from '../lib/identifiers';
import { unusablePasswordHash } from '../lib/tokens';
import { can, companyOf, h, requirePerm } from '../middleware/auth';
import { roleId } from '../services/reference';
import { issuePasswordLink } from './auth';

export const usersRouter = Router();

const zRole = z.enum(['SUPER_ADMIN', 'ADMIN', 'ACCOUNTANT', 'VIEWER']);
const zPhone = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().refine(isValidPhone, 'Enter a valid phone number').optional());

const view = (u: User & { role: Role }) => ({
  id: u.id, fullName: u.fullName, email: u.email, phone: u.phone, role: u.role.name, status: u.status,
  emailVerified: Boolean(u.emailVerifiedAt), lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
});

/** Privilege-escalation guard: touching an administrator, or granting an admin role, needs admins.manage. */
function assertRoleAuthority(req: Request, targetRole: string | null, newRole?: string) {
  const touchesAdmin = (targetRole && ADMIN_ROLES.includes(targetRole)) || (newRole && ADMIN_ROLES.includes(newRole));
  if (touchesAdmin && !can(req, 'admins.manage')) throw forbidden('Only a super administrator can create or modify administrator accounts');
}

async function targetUser(req: Request) {
  const u = await prisma.user.findFirst({ where: { id: req.params.id, companyId: companyOf(req) }, include: { role: true } });
  if (!u) throw notFound('User');
  return u;
}

async function assertNotLastSuperAdmin(companyId: string, user: User & { role: Role }) {
  if (user.role.name !== 'SUPER_ADMIN') return;
  const others = await prisma.user.count({ where: { companyId, status: 'ACTIVE', role: { name: 'SUPER_ADMIN' }, NOT: { id: user.id } } });
  if (others === 0) throw unprocessable('The company must keep at least one active super administrator', 'LAST_SUPER_ADMIN');
}

usersRouter.get('/', requirePerm('users.view'), h(async (req, res) => {
  const users = await prisma.user.findMany({ where: { companyId: companyOf(req) }, include: { role: true }, orderBy: { fullName: 'asc' } });
  res.json({ data: users.map(view) });
}));

usersRouter.get('/roles', requirePerm('users.view'), h(async (_req, res) => {
  res.json({
    data: {
      permissions: Object.entries(PERMISSIONS).map(([key, description]) => ({ key, description })),
      roles: ROLE_NAMES.map((name) => ({ name, description: ROLE_DESCRIPTIONS[name], permissions: ROLE_PERMISSIONS[name] })),
    },
  });
}));

usersRouter.post('/', requirePerm('users.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const d = parse(z.object({
    fullName: z.string({ required_error: 'Full name is required' }).trim().min(2, 'Full name is required').max(120),
    email: z.string({ required_error: 'Email is required' }).trim().toLowerCase().email('Enter a valid email address'),
    phone: zPhone,
    role: zRole,
  }), req.body);
  assertRoleAuthority(req, null, d.role);
  const rid = await roleId(d.role);
  const existing = await prisma.user.findUnique({ where: { email: d.email }, include: { role: true } });

  if (existing) {
    if (existing.companyId) throw conflict('A user with this email address already exists', 'EMAIL_TAKEN');
    // A self-registered account that no company has claimed yet: grant it access to this company.
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({ where: { id: existing.id }, data: { companyId, roleId: rid, phone: d.phone ?? existing.phone }, include: { role: true } });
      await audit(tx, { ...auditCtx(req), action: 'user.grant_access', entityType: 'User', entityId: u.id, summary: `Granted ${u.email} access to the company as ${d.role}` });
      return u;
    });
    return res.status(201).json({ data: view(user) });
  }

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: { companyId, roleId: rid, fullName: d.fullName, email: d.email, phone: d.phone ?? null, passwordHash: await unusablePasswordHash() },
      include: { role: true },
    });
    await audit(tx, { ...auditCtx(req), action: 'user.create', entityType: 'User', entityId: u.id, summary: `Created user ${u.email} with role ${d.role}` });
    return u;
  });
  await issuePasswordLink(user.id, user.email, user.fullName, 'invite');
  res.status(201).json({ data: view(user) });
}));

usersRouter.patch('/:id', requirePerm('users.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const target = await targetUser(req);
  const d = parse(z.object({ fullName: z.string().trim().min(2).max(120).optional(), phone: zPhone, role: zRole.optional() }), req.body);
  const roleChange = d.role && d.role !== target.role.name;
  assertRoleAuthority(req, target.role.name, roleChange ? d.role : undefined);
  if (roleChange) {
    if (target.id === req.auth!.userId) throw forbidden('You cannot change your own role');
    if (d.role !== 'SUPER_ADMIN') await assertNotLastSuperAdmin(companyId, target);
  }
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({
      where: { id: target.id },
      data: { fullName: d.fullName ?? target.fullName, phone: d.phone === undefined ? target.phone : d.phone, ...(roleChange ? { roleId: await roleId(d.role!) } : {}) },
      include: { role: true },
    });
    if (roleChange) {
      // Permissions are read per request, but revoke sessions so a demotion takes effect everywhere at once.
      await tx.userSession.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await audit(tx, { ...auditCtx(req), action: 'user.role_change', entityType: 'User', entityId: u.id, summary: `Changed role of ${u.email}: ${target.role.name} → ${d.role}` });
    } else {
      await audit(tx, { ...auditCtx(req), action: 'user.update', entityType: 'User', entityId: u.id, summary: `Updated profile of ${u.email}` });
    }
    return u;
  });
  res.json({ data: view(user) });
}));

usersRouter.patch('/:id/status', requirePerm('users.manage'), h(async (req, res) => {
  const companyId = companyOf(req);
  const target = await targetUser(req);
  const { status } = parse(z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) }), req.body);
  assertRoleAuthority(req, target.role.name);
  if (target.id === req.auth!.userId) throw forbidden('You cannot change the status of your own account');
  if (status === 'INACTIVE') await assertNotLastSuperAdmin(companyId, target);
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.update({ where: { id: target.id }, data: { status }, include: { role: true } });
    if (status === 'INACTIVE') await tx.userSession.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, { ...auditCtx(req), action: 'user.status_change', entityType: 'User', entityId: u.id, summary: `${status === 'ACTIVE' ? 'Activated' : 'Deactivated'} user ${u.email}` });
    return u;
  });
  res.json({ data: view(user) });
}));

// Administrators never see or set another person's password: they trigger an emailed, single-use link.
usersRouter.post('/:id/reset-password', requirePerm('users.manage'), h(async (req, res) => {
  const target = await targetUser(req);
  assertRoleAuthority(req, target.role.name);
  if (target.status !== 'ACTIVE') throw new AppError(422, 'INVALID_STATE', 'Activate the account before resetting its password');
  await prisma.userSession.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await issuePasswordLink(target.id, target.email, target.fullName, 'reset');
  await audit(prisma, { ...auditCtx(req), action: 'user.password_reset_sent', entityType: 'User', entityId: target.id, summary: `Sent a password reset link to ${target.email} and revoked their sessions` });
  res.json({ data: { message: `A password reset link has been emailed to ${target.email}` } });
}));

usersRouter.get('/:id/activity', requirePerm('users.view'), h(async (req, res) => {
  const target = await targetUser(req);
  const logs = await prisma.auditLog.findMany({
    where: { userId: target.id, companyId: companyOf(req) },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, action: true, entityType: true, summary: true, createdAt: true, ip: true },
  });
  res.json({ data: { user: view(target), activity: logs } });
}));

export const _zText = zText;
