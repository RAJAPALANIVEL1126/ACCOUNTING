import type { Request } from 'express';
import { z } from 'zod';
import { companyOf } from '../middleware/auth';
import type { Actor } from '../services/transactions';
import { addDays, today } from '../lib/dates';
import { parse, zDateOptional } from '../lib/validate';
import { badRequest } from '../lib/errors';
import { prisma, Prisma } from '../db';

export const actorOf = (req: Request): Actor => ({
  userId: req.auth!.userId,
  userName: req.auth!.user.fullName,
  companyId: companyOf(req),
  ip: req.ip ?? null,
  userAgent: (req.headers['user-agent'] || '').slice(0, 250) || null,
});

/** Date range from the query string. Defaults to the last 30 days. */
export function rangeOf(req: Request): { from: string; to: string } {
  const q = parse(z.object({ from: zDateOptional, to: zDateOptional }), { from: req.query.from, to: req.query.to });
  const to = q.to ?? today();
  const from = q.from ?? addDays(to, -29);
  if (to < from) throw badRequest('The end date cannot be before the start date');
  return { from, to };
}

/** Financial writes run SERIALIZABLE-safe via row locks; a generous timeout covers lock waits. */
export const inTx = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(fn, { timeout: 20000, maxWait: 10000 });

export const userNames = async (ids: Array<string | null | undefined>) => {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!unique.length) return new Map<string, string>();
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, fullName: true } });
  return new Map(users.map((u) => [u.id, u.fullName]));
};
