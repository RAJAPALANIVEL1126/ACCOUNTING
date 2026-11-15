import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { config } from '../config';
import { parse } from '../lib/validate';
import { AppError, unauthorized } from '../lib/errors';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/tokens';
import { sendMail } from '../lib/mailer';
import { audit, auditCtx } from '../lib/audit';
import { isValidPhone } from '../lib/identifiers';
import { clearSessionCookie, createSession, h, requireAuth } from '../middleware/auth';
import { roleId } from '../services/reference';

export const authRouter = Router();

export const zPassword = z
  .string({ required_error: 'Password is required' })
  .min(config.security.passwordMinLength, `Password must be at least ${config.security.passwordMinLength} characters`)
  .max(128, 'Password is too long')
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), 'Password must contain at least one letter and one number');
const zEmail = z.string({ required_error: 'Email is required' }).trim().toLowerCase().email('Enter a valid email address').max(200);

const signupSchema = z
  .object({
    fullName: z.string({ required_error: 'Full name is required' }).trim().min(2, 'Full name is required').max(120),
    email: zEmail,
    phone: z.string({ required_error: 'Phone number is required' }).trim().refine(isValidPhone, 'Enter a valid phone number'),
    password: zPassword,
    confirmPassword: z.string({ required_error: 'Confirm your password' }),
  })
  .refine((d) => d.password === d.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' });

export async function issueVerification(userId: string, email: string, fullName: string) {
  const token = randomToken();
  await prisma.emailVerificationToken.create({
    data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + config.security.verifyTokenHours * 3600 * 1000) },
  });
  await sendMail({
    to: email,
    subject: 'Verify your email address',
    text: `Hello ${fullName},\n\nConfirm your email address to activate your account:\n${config.appUrl}/verify-email?token=${token}\n\nThis link expires in ${config.security.verifyTokenHours} hours. If you did not sign up, ignore this message.`,
  });
}

export async function issuePasswordLink(userId: string, email: string, fullName: string, kind: 'reset' | 'invite') {
  const token = randomToken();
  const ms = kind === 'invite' ? config.security.inviteTokenHours * 3600 * 1000 : config.security.resetTokenMinutes * 60 * 1000;
  await prisma.passwordResetToken.create({ data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ms) } });
  const link = `${config.appUrl}/reset-password?token=${token}`;
  await sendMail(
    kind === 'invite'
      ? { to: email, subject: 'Set up your accounting account', text: `Hello ${fullName},\n\nAn administrator created an account for you. Choose your password here:\n${link}\n\nThis link expires in ${config.security.inviteTokenHours} hours.` }
      : { to: email, subject: 'Reset your password', text: `Hello ${fullName},\n\nUse this link to choose a new password:\n${link}\n\nThis link expires in ${config.security.resetTokenMinutes} minutes. If you did not request it, you can ignore this message.` },
  );
}

async function sessionPayload(req: Request) {
  const a = req.auth!;
  const company = a.companyId
    ? await prisma.company.findUnique({ where: { id: a.companyId }, select: { id: true, name: true, baseCurrency: true, fyStartMonth: true, logoAttachmentId: true } })
    : null;
  return {
    user: { id: a.user.id, fullName: a.user.fullName, email: a.user.email, phone: a.user.phone, role: a.role },
    company,
    permissions: [...a.permissions],
    csrfToken: a.csrfToken,
  };
}

// Public registration: always the least-privileged role, never attached to a company.
authRouter.post('/signup', h(async (req, res) => {
  const d = parse(signupSchema, req.body);
  const existing = await prisma.user.findUnique({ where: { email: d.email } });
  if (!existing) {
    const user = await prisma.user.create({
      data: { fullName: d.fullName, email: d.email, phone: d.phone, passwordHash: await hashPassword(d.password), roleId: await roleId('VIEWER') },
    });
    await issueVerification(user.id, user.email, user.fullName);
    await audit(prisma, { ...auditCtx(req), userId: user.id, userName: user.fullName, action: 'user.signup', entityType: 'User', entityId: user.id, summary: `Self-registration: ${user.email}` });
  }
  // Identical response whether or not the address was already registered (no account enumeration).
  res.status(201).json({ data: { message: 'Check your inbox for a verification link to activate your account.' } });
}));

authRouter.post('/verify-email', h(async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
  const rec = await prisma.emailVerificationToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!rec || rec.usedAt || rec.expiresAt < new Date()) throw new AppError(400, 'INVALID_TOKEN', 'This verification link is invalid or has expired');
  await prisma.$transaction([
    prisma.emailVerificationToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
    prisma.user.update({ where: { id: rec.userId }, data: { emailVerifiedAt: new Date() } }),
  ]);
  res.json({ data: { message: 'Email verified. You can now sign in.' } });
}));

authRouter.post('/resend-verification', h(async (req, res) => {
  const { email } = parse(z.object({ email: zEmail }), req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && !user.emailVerifiedAt && user.status === 'ACTIVE') await issueVerification(user.id, user.email, user.fullName);
  res.json({ data: { message: 'If the account exists and is unverified, a new link has been sent.' } });
}));

// A real Argon2 hash to burn equivalent time when the e-mail is unknown (prevents timing-based enumeration).
let dummyHash: Promise<string> | null = null;

authRouter.post('/login', h(async (req, res) => {
  const d = parse(z.object({ email: zEmail, password: z.string({ required_error: 'Password is required' }).min(1, 'Password is required').max(128) }), req.body);
  const invalid = new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
  const user = await prisma.user.findUnique({ where: { email: d.email }, include: { role: true } });
  if (!user) {
    dummyHash ??= hashPassword('not-a-real-password');
    await verifyPassword(await dummyHash, d.password);
    throw invalid;
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in a few minutes or reset your password.');
  }
  const ok = await verifyPassword(user.passwordHash, d.password);
  if (!ok) {
    const failed = user.failedLoginCount + 1;
    const lock = failed >= config.security.maxFailedLogins;
    await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: lock ? 0 : failed, lockedUntil: lock ? new Date(Date.now() + config.security.lockMinutes * 60000) : null },
    });
    await audit(prisma, { ...auditCtx(req), companyId: user.companyId, userId: user.id, userName: user.fullName, action: 'auth.login_failed', entityType: 'User', entityId: user.id, summary: `Failed sign-in for ${user.email}${lock ? ' — account temporarily locked' : ''}` });
    throw invalid;
  }
  if (user.status !== 'ACTIVE') throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account has been deactivated. Contact your administrator.');
  if (!user.emailVerifiedAt) throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address before signing in.');

  await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
  const { session, csrfToken } = await createSession(req, res, user.id);
  await audit(prisma, { ...auditCtx(req), companyId: user.companyId, userId: user.id, userName: user.fullName, action: 'auth.login', entityType: 'User', entityId: user.id, summary: `Signed in: ${user.email}` });
  req.auth = { userId: user.id, sessionId: session.id, csrfToken, companyId: user.companyId, role: user.role.name, permissions: (await import('../lib/permissions')).permissionsFor(user.role.name), user };
  res.json({ data: await sessionPayload(req) });
}));

authRouter.post('/logout', requireAuth, h(async (req, res) => {
  await prisma.userSession.update({ where: { id: req.auth!.sessionId }, data: { revokedAt: new Date() } });
  await audit(prisma, { ...auditCtx(req), action: 'auth.logout', entityType: 'User', entityId: req.auth!.userId, summary: `Signed out: ${req.auth!.user.email}` });
  clearSessionCookie(res);
  res.json({ data: { message: 'Signed out' } });
}));

authRouter.get('/me', h(async (req, res) => {
  if (!req.auth) throw unauthorized();
  res.json({ data: await sessionPayload(req) });
}));

authRouter.post('/forgot-password', h(async (req, res) => {
  const { email } = parse(z.object({ email: zEmail }), req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  if (user && user.status === 'ACTIVE') {
    await issuePasswordLink(user.id, user.email, user.fullName, 'reset');
    await audit(prisma, { ...auditCtx(req), companyId: user.companyId, userId: user.id, userName: user.fullName, action: 'auth.password_reset_requested', entityType: 'User', entityId: user.id, summary: `Password reset requested for ${user.email}` });
  }
  res.json({ data: { message: 'If an account exists for that address, a reset link has been sent.' } });
}));

authRouter.post('/reset-password', h(async (req, res) => {
  const d = parse(
    z.object({ token: z.string().min(20).max(200), password: zPassword, confirmPassword: z.string() })
      .refine((x) => x.password === x.confirmPassword, { path: ['confirmPassword'], message: 'Passwords do not match' }),
    req.body,
  );
  const rec = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(d.token) }, include: { user: true } });
  if (!rec || rec.usedAt || rec.expiresAt < new Date() || rec.user.status !== 'ACTIVE') {
    throw new AppError(400, 'INVALID_TOKEN', 'This password link is invalid or has expired');
  }
  const passwordHash = await hashPassword(d.password);
  await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
    prisma.passwordResetToken.updateMany({ where: { userId: rec.userId, usedAt: null }, data: { usedAt: new Date() } }),
    // Following the emailed link proves control of the mailbox.
    prisma.user.update({ where: { id: rec.userId }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null, emailVerifiedAt: rec.user.emailVerifiedAt ?? new Date() } }),
    prisma.userSession.updateMany({ where: { userId: rec.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await audit(prisma, { ...auditCtx(req), companyId: rec.user.companyId, userId: rec.userId, userName: rec.user.fullName, action: 'auth.password_reset', entityType: 'User', entityId: rec.userId, summary: `Password changed via emailed link for ${rec.user.email}; all sessions revoked` });
  res.json({ data: { message: 'Password updated. You can now sign in.' } });
}));

authRouter.post('/change-password', requireAuth, h(async (req, res) => {
  const d = parse(z.object({ currentPassword: z.string().min(1, 'Enter your current password'), newPassword: zPassword }), req.body);
  const user = req.auth!.user;
  if (!(await verifyPassword(user.passwordHash, d.currentPassword))) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Current password is incorrect', { fields: { currentPassword: 'Current password is incorrect' } });
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(d.newPassword) } }),
    prisma.userSession.updateMany({ where: { userId: user.id, revokedAt: null, NOT: { id: req.auth!.sessionId } }, data: { revokedAt: new Date() } }),
  ]);
  await audit(prisma, { ...auditCtx(req), action: 'auth.password_changed', entityType: 'User', entityId: user.id, summary: `Password changed by ${user.email}; other sessions revoked` });
  res.json({ data: { message: 'Password changed' } });
}));
