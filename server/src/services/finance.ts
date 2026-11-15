import type { AccountingMethod } from '@prisma/client';
import { prisma, Prisma } from '../db';
import { D, Dec, round2, ZERO } from '../lib/money';
import { daysBetween, eachDay, eachMonth } from '../lib/dates';
import { balancesBySubtype } from './ledger';

const S = Prisma.sql;

export type Granularity = 'day' | 'month';
export const pickGranularity = (from: string, to: string): Granularity => (daysBetween(from, to) > 92 ? 'month' : 'day');
const fmtOf = (g: Granularity) => (g === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM');
export const bucketsOf = (from: string, to: string, g: Granularity) => (g === 'day' ? eachDay(from, to) : eachMonth(from, to));

export const DIRECT_GROUPS = ['DIRECT_COST', 'COST_OF_GOODS_SOLD'];

/**
 * The set of recognised income / expense amounts, as rows (d, kind, categoryId, amount).
 *
 * ACCRUAL — every line posted to an income or expense ledger account, on its entry date
 *           (invoices count when issued, bills when recorded).
 * CASH    — income and expenses are recognised only when money moves: directly-settled
 *           transactions on their own date, plus the net-of-tax share of each invoice
 *           receipt / bill payment on the payment date. Refunds and reversals are negative.
 *
 * Every P&L figure in the application is derived from this one relation.
 */
export function recognizedSql(companyId: string, method: AccountingMethod): Prisma.Sql {
  const ledger = S`
    SELECT je."date" AS d,
           CASE WHEN a."type" = 'INCOME' THEN 'INCOME' ELSE 'EXPENSE' END AS kind,
           l."categoryId" AS "categoryId",
           CASE WHEN a."type" = 'INCOME' THEN l."credit" - l."debit" ELSE l."debit" - l."credit" END AS amount
    FROM "JournalEntryLine" l
    JOIN "JournalEntry" je ON je."id" = l."journalEntryId"
    JOIN "Account" a ON a."id" = l."accountId"
    LEFT JOIN "Transaction" t ON t."id" = je."transactionId"
    WHERE l."companyId" = ${companyId} AND a."type" IN ('INCOME', 'EXPENSE')`;
  if (method === 'ACCRUAL') return ledger;
  return S`${ledger} AND je."invoiceId" IS NULL AND COALESCE(t."onCredit", false) = false
    UNION ALL
    SELECT pa."date", 'INCOME', ii."categoryId", pa."amount" * ii."lineNet" / i."total"
    FROM "PaymentAllocation" pa
    JOIN "Invoice" i ON i."id" = pa."invoiceId"
    JOIN "InvoiceItem" ii ON ii."invoiceId" = i."id"
    WHERE pa."companyId" = ${companyId} AND i."total" > 0
    UNION ALL
    SELECT pa."date", 'EXPENSE', bt."categoryId",
           pa."amount" * (bt."totalAmount" - CASE WHEN bt."taxRecoverable" THEN bt."taxAmount" ELSE 0 END) / bt."totalAmount"
    FROM "PaymentAllocation" pa
    JOIN "Transaction" bt ON bt."id" = pa."billTransactionId"
    WHERE pa."companyId" = ${companyId} AND bt."totalAmount" > 0`;
}

export interface CategoryTotal {
  kind: 'INCOME' | 'EXPENSE';
  categoryId: string | null;
  name: string;
  plGroup: string;
  amount: Dec;
}

export async function plByCategory(companyId: string, from: string, to: string, method: AccountingMethod): Promise<CategoryTotal[]> {
  const rows = await prisma.$queryRaw<{ kind: string; categoryId: string | null; name: string | null; plGroup: string | null; amount: Dec }[]>`
    SELECT r.kind, r."categoryId", c."name", c."plGroup"::text AS "plGroup", SUM(r.amount) AS amount
    FROM (${recognizedSql(companyId, method)}) r
    LEFT JOIN "TransactionCategory" c ON c."id" = r."categoryId"
    WHERE r.d BETWEEN ${from}::date AND ${to}::date
    GROUP BY r.kind, r."categoryId", c."name", c."plGroup"
    ORDER BY c."name"`;
  return rows
    .map((r) => ({
      kind: r.kind as 'INCOME' | 'EXPENSE',
      categoryId: r.categoryId,
      name: r.name ?? 'Uncategorised',
      plGroup: r.plGroup ?? (r.kind === 'INCOME' ? 'OTHER_OPERATING_INCOME' : 'OTHER_EXPENSE'),
      amount: round2(D(r.amount)),
    }))
    .filter((r) => !r.amount.isZero());
}

export interface PlTotals {
  salesRevenue: Dec;
  otherIncome: Dec;
  totalIncome: Dec;
  directCosts: Dec;
  grossProfit: Dec;
  operatingExpenses: Dec;
  totalExpenses: Dec;
  netProfit: Dec;
}

export function plTotals(cats: CategoryTotal[]): PlTotals {
  let salesRevenue = ZERO, otherIncome = ZERO, directCosts = ZERO, operatingExpenses = ZERO;
  for (const c of cats) {
    if (c.kind === 'INCOME') {
      if (c.plGroup === 'SALES_REVENUE') salesRevenue = salesRevenue.plus(c.amount);
      else otherIncome = otherIncome.plus(c.amount);
    } else if (DIRECT_GROUPS.includes(c.plGroup)) directCosts = directCosts.plus(c.amount);
    else operatingExpenses = operatingExpenses.plus(c.amount);
  }
  const totalIncome = salesRevenue.plus(otherIncome);
  const totalExpenses = directCosts.plus(operatingExpenses);
  return {
    salesRevenue, otherIncome, totalIncome, directCosts,
    grossProfit: totalIncome.minus(directCosts),
    operatingExpenses, totalExpenses,
    netProfit: totalIncome.minus(totalExpenses),
  };
}

export interface PlPoint { bucket: string; income: Dec; expenses: Dec; profit: Dec }

export async function plSeries(companyId: string, from: string, to: string, g: Granularity, method: AccountingMethod): Promise<PlPoint[]> {
  const rows = await prisma.$queryRaw<{ bucket: string; kind: string; amount: Dec }[]>`
    SELECT to_char(r.d, ${fmtOf(g)}) AS bucket, r.kind, SUM(r.amount) AS amount
    FROM (${recognizedSql(companyId, method)}) r
    WHERE r.d BETWEEN ${from}::date AND ${to}::date
    GROUP BY 1, 2`;
  const map = new Map<string, { income: Dec; expenses: Dec }>();
  for (const r of rows) {
    const e = map.get(r.bucket) ?? { income: ZERO, expenses: ZERO };
    if (r.kind === 'INCOME') e.income = e.income.plus(D(r.amount));
    else e.expenses = e.expenses.plus(D(r.amount));
    map.set(r.bucket, e);
  }
  return bucketsOf(from, to, g).map((bucket) => {
    const e = map.get(bucket) ?? { income: ZERO, expenses: ZERO };
    const income = round2(e.income), expenses = round2(e.expenses);
    return { bucket, income, expenses, profit: income.minus(expenses) };
  });
}

export interface CashPoint {
  bucket: string;
  cashIn: Dec; cashOut: Dec; bankIn: Dec; bankOut: Dec; onlineIn: Dec; onlineOut: Dec;
  inflow: Dec; outflow: Dec; net: Dec;
}

const ONLINE = S`('UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'PAYMENT_GATEWAY', 'BANK_TRANSFER')`;

/** Movements on cash and bank accounts, bucketed. Optionally restricted to one account. */
export async function cashSeries(companyId: string, from: string, to: string, g: Granularity, accountId?: string): Promise<CashPoint[]> {
  const accountFilter = accountId ? S`AND x."accountId" = ${accountId}` : S``;
  const rows = await prisma.$queryRaw<{ bucket: string; subtype: string; direction: string; online: boolean; amount: Dec }[]>`
    SELECT to_char(x."date", ${fmtOf(g)}) AS bucket, a."subtype"::text AS subtype, x."direction"::text AS direction,
           (x."paymentMethod"::text IN ${ONLINE} AND x."isTransfer" = false) AS online, SUM(x."amount") AS amount
    FROM "AccountTransaction" x
    JOIN "Account" a ON a."id" = x."accountId"
    WHERE x."companyId" = ${companyId} AND x."date" BETWEEN ${from}::date AND ${to}::date ${accountFilter}
    GROUP BY 1, 2, 3, 4`;
  const blank = () => ({ cashIn: ZERO, cashOut: ZERO, bankIn: ZERO, bankOut: ZERO, onlineIn: ZERO, onlineOut: ZERO });
  const map = new Map<string, ReturnType<typeof blank>>();
  for (const r of rows) {
    const e = map.get(r.bucket) ?? blank();
    const amt = D(r.amount);
    const key = ((r.subtype === 'CASH' ? 'cash' : 'bank') + (r.direction === 'IN' ? 'In' : 'Out')) as 'cashIn' | 'cashOut' | 'bankIn' | 'bankOut';
    e[key] = e[key].plus(amt);
    if (r.online) {
      if (r.direction === 'IN') e.onlineIn = e.onlineIn.plus(amt);
      else e.onlineOut = e.onlineOut.plus(amt);
    }
    map.set(r.bucket, e);
  }
  return bucketsOf(from, to, g).map((bucket) => {
    const e = map.get(bucket) ?? blank();
    const inflow = e.cashIn.plus(e.bankIn), outflow = e.cashOut.plus(e.bankOut);
    return { bucket, ...e, inflow, outflow, net: inflow.minus(outflow) };
  });
}

/** Combined cash + bank book balance at the start of a date (i.e. everything before it). */
export async function openingCashBank(companyId: string, before: string, accountId?: string): Promise<Dec> {
  const accountFilter = accountId ? S`AND x."accountId" = ${accountId}` : S``;
  const rows = await prisma.$queryRaw<{ bal: Dec | null }[]>`
    SELECT SUM(CASE WHEN x."direction" = 'IN' THEN x."amount" ELSE -x."amount" END) AS bal
    FROM "AccountTransaction" x
    WHERE x."companyId" = ${companyId} AND x."date" < ${before}::date ${accountFilter}`;
  return D(rows[0]?.bal);
}

export async function positionAsOf(companyId: string, asOf: string) {
  const b = await balancesBySubtype(prisma, companyId, asOf);
  return {
    cashBalance: b.CASH ?? ZERO,
    bankBalance: b.BANK ?? ZERO,
    receivables: b.RECEIVABLE ?? ZERO,
    payables: (b.PAYABLE ?? ZERO).negated(),
    taxOutput: (b.TAX_OUTPUT ?? ZERO).negated(),
    taxInput: b.TAX_INPUT ?? ZERO,
  };
}

export async function paymentMethodBreakdown(companyId: string, from: string, to: string) {
  const rows = await prisma.$queryRaw<{ method: string; direction: string; count: bigint; amount: Dec }[]>`
    SELECT x."paymentMethod"::text AS method, x."direction"::text AS direction, COUNT(*) AS count, SUM(x."amount") AS amount
    FROM "AccountTransaction" x
    WHERE x."companyId" = ${companyId} AND x."isTransfer" = false AND x."date" BETWEEN ${from}::date AND ${to}::date
    GROUP BY 1, 2`;
  const map = new Map<string, { method: string; count: number; received: Dec; paid: Dec }>();
  for (const r of rows) {
    const e = map.get(r.method) ?? { method: r.method, count: 0, received: ZERO, paid: ZERO };
    e.count += Number(r.count);
    if (r.direction === 'IN') e.received = e.received.plus(D(r.amount));
    else e.paid = e.paid.plus(D(r.amount));
    map.set(r.method, e);
  }
  return [...map.values()].sort((a, b) => b.received.plus(b.paid).cmp(a.received.plus(a.paid)));
}

export async function accountingMethodOf(companyId: string): Promise<AccountingMethod> {
  const s = await prisma.companySettings.findUnique({ where: { companyId }, select: { accountingMethod: true } });
  return s?.accountingMethod ?? 'ACCRUAL';
}
