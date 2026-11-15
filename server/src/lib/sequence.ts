import { Tx } from '../db';

/** Race-safe per-company counters (the upsert row-locks the counter until commit). */
export async function nextSequence(tx: Tx, companyId: string, name: string): Promise<number> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "Sequence" ("companyId", "name", "value") VALUES (${companyId}, ${name}, 1)
    ON CONFLICT ("companyId", "name") DO UPDATE SET "value" = "Sequence"."value" + 1
    RETURNING "value"`;
  return Number(rows[0].value);
}
export const pad = (n: number, width = 6) => String(n).padStart(width, '0');
