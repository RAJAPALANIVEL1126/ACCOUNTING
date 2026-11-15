import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { User, Role } from '@prisma/client';
import { prisma } from '../db';
import { config } from '../config';
import { sha256, randomToken, safeEqual } from '../lib/tokens';
import { AppError, forbidden, unauthorized } from '../lib/errors';
import { PermissionKey, permissionsFor } from '../lib/permissions';

export const SESSION_COOKIE = 'cas_session';

export interface AuthContext {
  userId: string;
  sessionId: string;
  csrfToken: string;
  companyId: string | null;
  role: string;
  permissions: Set<PermissionKey>;
  user: User & { role: Role };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      rawBody?: Buffer;
    }
  }
}

/** Wrap async handlers so rejections reach the central error handler (Express 4). */
export const h =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

const cookieOptions = () => ({
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: config.sessionTtlHours * 3600 * 1000,
});

export async function createSession(req: Request, res: Response, userId: string) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const session = await prisma.userSession.create({
    data: {
      userId,
      tokenHash: sha256(token),
      csrfToken,
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] || '').slice(0, 250) || null,
      expiresAt: new Date(Date.now() + config.sessionTtlHours * 3600 * 1000),
    },
  });
  res.cookie(SESSION_COOKIE, token, cookieOptions());
  return { session, csrfToken };
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
}

/** Resolves the session cookie (if any) into req.auth. Never throws for anonymous requests. */
export const loadSession: RequestHandler = h(async (req, _res, next) => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === 'string' && token.length > 20) {
    const s = await prisma.userSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { user: { include: { role: true } } },
    });
    if (s && !s.revokedAt && s.expiresAt > new Date() && s.user.status === 'ACTIVE') {
      req.auth = {
        userId: s.userId,
        sessionId: s.id,
        csrfToken: s.csrfToken,
        companyId: s.user.companyId,
        role: s.user.role.name,
        permissions: permissionsFor(s.user.role.name),
        user: s.user,
      };
      if (Date.now() - s.lastSeenAt.getTime() > 5 * 60 * 1000) {
        prisma.userSession.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
      }
    }
  }
  next();
});

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Authenticated + CSRF-checked (state-changing requests must echo the session's CSRF token). */
export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.auth) return next(unauthorized());
  if (!SAFE_METHODS.has(req.method)) {
    const sent = req.headers['x-csrf-token'];
    if (typeof sent !== 'string' || !safeEqual(sent, req.auth.csrfToken)) {
      return next(new AppError(403, 'CSRF_INVALID', 'Security token missing or invalid. Refresh the page and try again.'));
    }
  }
  next();
};

/** Authenticated, attached to a company, and holding every listed permission. */
export const requirePerm =
  (...perms: PermissionKey[]): RequestHandler =>
  (req, res, next) => {
    requireAuth(req, res, (err?: unknown) => {
      if (err) return next(err);
      const a = req.auth!;
      if (!a.companyId) return next(new AppError(403, 'NO_COMPANY', 'Your account is not attached to a company yet'));
      for (const p of perms) if (!a.permissions.has(p)) return next(forbidden());
      next();
    });
  };

/** Tenant id for the current request. Only call after requirePerm. */
export const companyOf = (req: Request): string => {
  const id = req.auth?.companyId;
  if (!id) throw new AppError(403, 'NO_COMPANY', 'Your account is not attached to a company yet');
  return id;
};
export const can = (req: Request, p: PermissionKey) => Boolean(req.auth?.permissions.has(p));
