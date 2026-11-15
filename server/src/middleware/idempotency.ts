import type { RequestHandler } from 'express';
import { prisma, Prisma } from '../db';
import { AppError } from '../lib/errors';
import { h } from './auth';

/**
 * Duplicate-submission protection for financial POSTs.
 *
 * Clients send an `Idempotency-Key` header (one key per form submission). The key is
 * claimed with a unique insert *before* the handler runs:
 *   - first request  → runs, and its response is stored against the key
 *   - replay         → the stored response is returned, nothing is posted twice
 *   - concurrent dup → 409 while the first request is still in flight
 * A failed request releases its key so the user can correct and retry.
 */
export const idempotent: RequestHandler = h(async (req, res, next) => {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !key) return next();
  if (key.length < 8 || key.length > 100) throw new AppError(400, 'BAD_REQUEST', 'Invalid Idempotency-Key header');
  const userId = req.auth!.userId;

  try {
    await prisma.idempotencyRecord.create({ data: { userId, key, method: req.method, path: req.originalUrl.split('?')[0] } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const existing = await prisma.idempotencyRecord.findUnique({ where: { userId_key: { userId, key } } });
      if (existing?.state === 'DONE' && existing.responseStatus) {
        res.setHeader('Idempotent-Replay', 'true');
        return res.status(existing.responseStatus).json(existing.responseBody);
      }
      throw new AppError(409, 'DUPLICATE_REQUEST', 'This request is already being processed');
    }
    throw e;
  }

  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    const finish = async () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        await prisma.idempotencyRecord.update({
          where: { userId_key: { userId, key } },
          data: { state: 'DONE', responseStatus: res.statusCode, responseBody: JSON.parse(JSON.stringify(body ?? null)) },
        });
      } else {
        await prisma.idempotencyRecord.delete({ where: { userId_key: { userId, key } } });
      }
    };
    finish().catch(() => undefined).finally(() => originalJson(body));
    return res;
  };
  next();
});
