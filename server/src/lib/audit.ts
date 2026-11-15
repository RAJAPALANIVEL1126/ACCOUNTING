import type { Request } from 'express';
import { prisma, Tx, Prisma } from '../db';

export interface AuditInput {
  companyId?: string | null;
  userId?: string | null;
  userName?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

const SENSITIVE = /(password|token|secret|hash|csrf)/i;
function clean(meta?: Record<string, unknown>): Prisma.InputJsonValue | undefined {
  if (!meta) return undefined;
  return JSON.parse(JSON.stringify(meta, (k, v) => (SENSITIVE.test(k) ? undefined : v)));
}

export function auditCtx(req: Request) {
  return {
    companyId: req.auth?.companyId ?? null,
    userId: req.auth?.userId ?? null,
    userName: req.auth?.user.fullName ?? null,
    ip: req.ip ?? null,
    userAgent: (req.headers['user-agent'] || '').slice(0, 250) || null,
  };
}

export async function audit(db: Tx | typeof prisma, input: AuditInput) {
  await db.auditLog.create({
    data: {
      companyId: input.companyId ?? null,
      userId: input.userId ?? null,
      userName: input.userName ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      summary: input.summary.slice(0, 1000),
      metadata: clean(input.metadata),
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}

/** Field-level change summary for audit entries (never includes sensitive keys). */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after)) {
    if (SENSITIVE.test(k) || after[k] === undefined) continue;
    const a = before[k] instanceof Date ? (before[k] as Date).toISOString() : before[k];
    const b = after[k] instanceof Date ? (after[k] as Date).toISOString() : after[k];
    if (String(a ?? '') !== String(b ?? '')) changes[k] = { from: a ?? null, to: b ?? null };
  }
  return changes;
}
