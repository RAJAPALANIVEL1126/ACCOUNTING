import type { Account, AccountSubtype, PaymentMethod } from '@prisma/client';
import { prisma, Prisma, Tx } from '../db';
import { AppError, notFound, unprocessable } from '../lib/errors';
import { D, Dec, round2, sum, ZERO } from '../lib/money';
import { nextSequence, pad } from '../lib/sequence';
import { fmtDate } from '../lib/dates';

export interface LineInput {
  accountId: string;
  debit?: Dec | null;
  credit?: Dec | null;
  categoryId?: string | null;
  customerId?: string | null;
  supplierId?: string | null;
  memo?: string | null;
}

export interface PostJournalInput {
  companyId: string;
  date: Date;
  description?: string | null;
  transactionId?: string | null;
  invoiceId?: string | null;
  isReversal?: boolean;
  createdById?: string | null;
  paymentMethod?: PaymentMethod;
  isTransfer?: boolean;
  lines: LineInput[];
}

type Db = Tx | typeof prisma;

export async function systemAccount(db: Db, companyId: string, subtype: AccountSubtype): Promise<Account> {
  const a = await db.account.findFirst({ where: { companyId, subtype, isSystem: true } });
  if (!a) throw new AppError(500, 'CONFIG_ERROR', `System account ${subtype} is missing for this company`);
  return a;
}

/**
 * Posts one balanced journal entry. This is the only place ledger lines are written.
 *
 *  - Total debits must equal total credits (also enforced by a deferred DB constraint trigger).
 *  - Every referenced account must belong to the company (tenant isolation) and is row-locked,
 *    which serialises concurrent postings against the same account.
 *  - Lines on cash/bank accounts are mirrored into the cash/bank book (AccountTransaction).
 *  - A cash-in-hand account can never be driven below zero.
 */
export async function postJournal(tx: Tx, p: PostJournalInput) {
  const lines = p.lines
    .map((l) => ({ ...l, debit: round2(D(l.debit)), credit: round2(D(l.credit)) }))
    .filter((l) => !(l.debit.isZero() && l.credit.isZero()));

  if (lines.length < 2) throw unprocessable('A journal entry needs at least two non-zero lines', 'INVALID_ENTRY');
  for (const l of lines) {
    if (l.debit.lt(0) || l.credit.lt(0)) throw unprocessable('Journal amounts cannot be negative', 'INVALID_ENTRY');
    if (l.debit.gt(0) && l.credit.gt(0)) throw unprocessable('A journal line cannot have both a debit and a credit', 'INVALID_ENTRY');
  }
  const totalDebit = sum(lines.map((l) => l.debit));
  const totalCredit = sum(lines.map((l) => l.credit));
  if (!totalDebit.eq(totalCredit)) {
    throw new AppError(422, 'UNBALANCED_ENTRY', `Journal entry is not balanced (debits ${totalDebit.toFixed(2)} ≠ credits ${totalCredit.toFixed(2)})`);
  }

  const ids = [...new Set(lines.map((l) => l.accountId))].sort();
  const accounts = await tx.$queryRaw<{ id: string; subtype: string; name: string; isActive: boolean }[]>`
    SELECT "id", "subtype"::text AS "subtype", "name", "isActive" FROM "Account"
    WHERE "companyId" = ${p.companyId} AND "id" IN (${Prisma.join(ids)})
    ORDER BY "id" FOR UPDATE`;
  if (accounts.length !== ids.length) throw notFound('Account');
  const byId = new Map(accounts.map((a) => [a.id, a]));

  const number = 'JE-' + pad(await nextSequence(tx, p.companyId, 'JE'));
  const entry = await tx.journalEntry.create({
    data: {
      companyId: p.companyId,
      number,
      date: p.date,
      description: p.description ?? null,
      transactionId: p.transactionId ?? null,
      invoiceId: p.invoiceId ?? null,
      isReversal: p.isReversal ?? false,
      createdById: p.createdById ?? null,
    },
  });
  await tx.journalEntryLine.createMany({
    data: lines.map((l) => ({
      journalEntryId: entry.id,
      companyId: p.companyId,
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      categoryId: l.categoryId ?? null,
      customerId: l.customerId ?? null,
      supplierId: l.supplierId ?? null,
      memo: l.memo ?? null,
    })),
  });

  const moneyLines = lines.filter((l) => ['CASH', 'BANK'].includes(byId.get(l.accountId)!.subtype));
  if (moneyLines.length) {
    if (!p.transactionId) throw new AppError(500, 'INVALID_ENTRY', 'Cash and bank movements must belong to a transaction');
    await tx.accountTransaction.createMany({
      data: moneyLines.map((l) => ({
        companyId: p.companyId,
        accountId: l.accountId,
        transactionId: p.transactionId!,
        date: p.date,
        direction: l.debit.gt(0) ? ('IN' as const) : ('OUT' as const),
        amount: l.debit.gt(0) ? l.debit : l.credit,
        paymentMethod: p.paymentMethod ?? 'OTHER',
        isTransfer: p.isTransfer ?? false,
      })),
    });
    for (const l of moneyLines) {
      const acc = byId.get(l.accountId)!;
      if (acc.subtype === 'CASH' && l.credit.gt(0)) {
        const bal = await accountBalance(tx, p.companyId, l.accountId);
        if (bal.lt(0)) throw unprocessable(`Insufficient balance in cash account "${acc.name}"`, 'INSUFFICIENT_CASH');
      }
    }
  }
  return entry;
}

/** Book balance of an asset account (debits − credits), optionally as of a date (inclusive). */
export async function accountBalance(db: Db, companyId: string, accountId: string, asOf?: string): Promise<Dec> {
  const rows = asOf
    ? await db.$queryRaw<{ bal: Dec | null }[]>`
        SELECT SUM(l."debit" - l."credit") AS bal FROM "JournalEntryLine" l
        JOIN "JournalEntry" je ON je."id" = l."journalEntryId"
        WHERE l."companyId" = ${companyId} AND l."accountId" = ${accountId} AND je."date" <= ${asOf}::date`
    : await db.$queryRaw<{ bal: Dec | null }[]>`
        SELECT SUM(l."debit" - l."credit") AS bal FROM "JournalEntryLine" l
        WHERE l."companyId" = ${companyId} AND l."accountId" = ${accountId}`;
  return D(rows[0]?.bal);
}

/** Book balances (debits − credits) for every account of the company, optionally as of a date. */
export async function balancesByAccount(db: Db, companyId: string, asOf?: string): Promise<Map<string, Dec>> {
  const rows = await db.$queryRaw<{ accountId: string; bal: Dec }[]>`
    SELECT l."accountId", SUM(l."debit" - l."credit") AS bal FROM "JournalEntryLine" l
    JOIN "JournalEntry" je ON je."id" = l."journalEntryId"
    WHERE l."companyId" = ${companyId} AND je."date" <= ${asOf ?? '9999-12-31'}::date
    GROUP BY l."accountId"`;
  return new Map(rows.map((r) => [r.accountId, D(r.bal)]));
}

/** Net (debits − credits) per account subtype, as of a date. */
export async function balancesBySubtype(db: Db, companyId: string, asOf?: string): Promise<Record<string, Dec>> {
  const rows = await db.$queryRaw<{ subtype: string; bal: Dec }[]>`
    SELECT a."subtype"::text AS subtype, SUM(l."debit" - l."credit") AS bal FROM "JournalEntryLine" l
    JOIN "JournalEntry" je ON je."id" = l."journalEntryId"
    JOIN "Account" a ON a."id" = l."accountId"
    WHERE l."companyId" = ${companyId} AND je."date" <= ${asOf ?? '9999-12-31'}::date
    GROUP BY a."subtype"`;
  const out: Record<string, Dec> = {};
  for (const r of rows) out[r.subtype] = D(r.bal);
  return out;
}

/** Outstanding balance per customer (receivable) or supplier (payable), as of a date. Positive = owed. */
export async function partyBalances(db: Db, companyId: string, party: 'customer' | 'supplier', asOf?: string): Promise<Map<string, Dec>> {
  const col = party === 'customer' ? Prisma.sql`l."customerId"` : Prisma.sql`l."supplierId"`;
  const subtype = party === 'customer' ? 'RECEIVABLE' : 'PAYABLE';
  const sign = party === 'customer' ? Prisma.sql`l."debit" - l."credit"` : Prisma.sql`l."credit" - l."debit"`;
  const rows = await db.$queryRaw<{ id: string; bal: Dec }[]>`
    SELECT ${col} AS id, SUM(${sign}) AS bal FROM "JournalEntryLine" l
    JOIN "JournalEntry" je ON je."id" = l."journalEntryId"
    JOIN "Account" a ON a."id" = l."accountId"
    WHERE l."companyId" = ${companyId} AND a."subtype"::text = ${subtype} AND ${col} IS NOT NULL
      AND je."date" <= ${asOf ?? '9999-12-31'}::date
    GROUP BY ${col}`;
  return new Map(rows.map((r) => [r.id, D(r.bal)]));
}

export async function partyBalance(db: Db, companyId: string, party: 'customer' | 'supplier', id: string): Promise<Dec> {
  return (await partyBalances(db, companyId, party)).get(id) ?? ZERO;
}

/** Mirror image of a set of posted lines (used for reversals and cancellations). */
export function mirrorLines(lines: Array<{ accountId: string; debit: Dec; credit: Dec; categoryId: string | null; customerId: string | null; supplierId: string | null; memo: string | null }>): LineInput[] {
  return lines.map((l) => ({
    accountId: l.accountId,
    debit: l.credit,
    credit: l.debit,
    categoryId: l.categoryId,
    customerId: l.customerId,
    supplierId: l.supplierId,
    memo: l.memo,
  }));
}

export const dateLabel = (d: Date) => fmtDate(d);
