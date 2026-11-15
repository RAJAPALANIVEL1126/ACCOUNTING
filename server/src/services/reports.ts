import type { AccountingMethod } from '@prisma/client';
import { prisma, Prisma } from '../db';
import { D, Dec, money, sum, ZERO } from '../lib/money';
import { addDays, daysBetween, fmtDate, previousPeriod } from '../lib/dates';
import { AppError, badRequest } from '../lib/errors';
import {
  accountingMethodOf, cashSeries, DIRECT_GROUPS, Granularity, openingCashBank, plByCategory, plSeries, plTotals, positionAsOf, CategoryTotal,
} from './finance';
import { partyBalances } from './ledger';

const S = Prisma.sql;

export type ColType = 'text' | 'money' | 'date' | 'number';
export interface ReportColumn { key: string; label: string; type?: ColType }
export interface ReportRow { [key: string]: unknown; _style?: 'section' | 'total' | 'subtotal' }
export interface Report {
  key: string;
  title: string;
  note?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  totals?: Record<string, string>;
  meta: {
    companyName: string;
    currency: string;
    from?: string;
    to?: string;
    asOf?: string;
    generatedAt: string;
    accountingMethod: AccountingMethod;
    basis: string;
    filters: Record<string, string>;
  };
}

export interface ReportParams {
  from: string;
  to: string;
  categoryId?: string;
  accountId?: string;
  paymentMethod?: string;
  customerId?: string;
  supplierId?: string;
  q?: string;
  compare?: boolean;
}

export const REPORTS: Record<string, { title: string; description: string; filters: string[] }> = {
  daily: { title: 'Daily Financial Report', description: 'Day-by-day income, expenses, cash movement and profit', filters: [] },
  monthly: { title: 'Monthly Financial Report', description: 'Month-by-month income, expenses, cash movement and profit', filters: [] },
  annual: { title: 'Annual Financial Report', description: 'Totals by financial year', filters: [] },
  'profit-loss': { title: 'Profit and Loss Statement', description: 'Revenue, direct costs, operating expenses and net profit', filters: ['compare'] },
  income: { title: 'Income Report', description: 'Every amount posted to income, by category', filters: ['categoryId', 'paymentMethod', 'customerId', 'q'] },
  expenses: { title: 'Expense Report', description: 'Every amount posted to expenses, by category', filters: ['categoryId', 'paymentMethod', 'supplierId', 'q'] },
  'cash-flow': { title: 'Cash Flow Statement', description: 'Money in and out of cash and bank accounts', filters: ['accountId'] },
  'cash-accounts': { title: 'Cash Account Report', description: 'Opening, movement and closing balance per cash account', filters: [] },
  'bank-accounts': { title: 'Bank Account Report', description: 'Opening, movement and closing balance per bank account', filters: [] },
  'online-payments': { title: 'Online Payment Report', description: 'Online payments with fees, status and reconciliation', filters: ['paymentMethod', 'q'] },
  receivables: { title: 'Outstanding Receivables', description: 'Amounts owed by customers', filters: ['q'] },
  payables: { title: 'Outstanding Payables', description: 'Amounts owed to suppliers', filters: ['q'] },
  'customer-transactions': { title: 'Customer Transaction Report', description: 'Invoices, receipts and refunds per customer', filters: ['customerId', 'q'] },
  'supplier-transactions': { title: 'Supplier Transaction Report', description: 'Bills and payments per supplier', filters: ['supplierId', 'q'] },
  'tax-summary': { title: 'Tax Summary', description: 'Output tax collected and recoverable input tax', filters: [] },
};

const m = (d: Dec) => money(d);
const METHOD_LABEL: Record<AccountingMethod, string> = {
  ACCRUAL: 'Accrual basis — income when invoiced/earned, expenses when incurred',
  CASH: 'Cash basis — income and expenses recognised when money is received or paid',
};

async function baseMeta(companyId: string, p: ReportParams, filters: Record<string, string> = {}) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true, baseCurrency: true, fyStartMonth: true } });
  const method = await accountingMethodOf(companyId);
  return {
    company,
    method,
    meta: {
      companyName: company.name,
      currency: company.baseCurrency,
      from: p.from,
      to: p.to,
      generatedAt: new Date().toISOString(),
      accountingMethod: method,
      basis: METHOD_LABEL[method],
      filters,
    },
  };
}

// ───────────────────────── Period reports (daily / monthly / annual) ─────────────────────────

const PERIOD_COLS: ReportColumn[] = [
  { key: 'period', label: 'Period' },
  { key: 'opening', label: 'Opening Cash Balance', type: 'money' },
  { key: 'income', label: 'Total Income', type: 'money' },
  { key: 'expenses', label: 'Total Expenses', type: 'money' },
  { key: 'cashIn', label: 'Cash Received', type: 'money' },
  { key: 'cashOut', label: 'Cash Paid', type: 'money' },
  { key: 'bankIn', label: 'Bank Receipts', type: 'money' },
  { key: 'bankOut', label: 'Bank Payments', type: 'money' },
  { key: 'onlineIn', label: 'Online Receipts', type: 'money' },
  { key: 'onlineOut', label: 'Online Payments', type: 'money' },
  { key: 'net', label: 'Net Cash Flow', type: 'money' },
  { key: 'closing', label: 'Closing Cash Balance', type: 'money' },
  { key: 'profit', label: 'Profit / Loss', type: 'money' },
];
const FLOW_KEYS = ['income', 'expenses', 'cashIn', 'cashOut', 'bankIn', 'bankOut', 'onlineIn', 'onlineOut', 'net', 'profit'] as const;

export interface PeriodRow {
  period: string;
  opening: Dec; closing: Dec;
  income: Dec; expenses: Dec; cashIn: Dec; cashOut: Dec; bankIn: Dec; bankOut: Dec; onlineIn: Dec; onlineOut: Dec; net: Dec; profit: Dec;
}

/** Shared engine for daily / monthly figures: closing = opening + net cash flow for every row. */
export async function periodRows(companyId: string, from: string, to: string, g: Granularity, method: AccountingMethod): Promise<PeriodRow[]> {
  const [pl, cash, opening] = await Promise.all([
    plSeries(companyId, from, to, g, method),
    cashSeries(companyId, from, to, g),
    openingCashBank(companyId, from),
  ]);
  let running = opening;
  return pl.map((p, i) => {
    const c = cash[i];
    const open = running;
    running = running.plus(c.net);
    return {
      period: p.bucket, opening: open, closing: running,
      income: p.income, expenses: p.expenses, profit: p.profit,
      cashIn: c.cashIn, cashOut: c.cashOut, bankIn: c.bankIn, bankOut: c.bankOut, onlineIn: c.onlineIn, onlineOut: c.onlineOut, net: c.net,
    };
  });
}

function periodReport(key: string, rows: PeriodRow[], meta: Report['meta']): Report {
  const totals: Record<string, string> = { period: 'Total' };
  for (const k of FLOW_KEYS) totals[k] = m(sum(rows.map((r) => r[k])));
  if (rows.length) {
    totals.opening = m(rows[0].opening);
    totals.closing = m(rows[rows.length - 1].closing);
  }
  return {
    key,
    title: REPORTS[key].title,
    note: 'Cash balance = all cash and bank accounts. Closing = Opening + Net Cash Flow. Online receipts/payments are the part of bank movements made by UPI, cards, net banking, gateway or bank transfer. Transfers between own accounts appear on both sides and net to zero.',
    columns: PERIOD_COLS,
    rows: rows.map((r) => {
      const out: ReportRow = { period: r.period, opening: m(r.opening), closing: m(r.closing) };
      for (const k of FLOW_KEYS) out[k] = m(r[k]);
      return out;
    }),
    totals,
    meta,
  };
}

function fyLabel(month: string, fyStartMonth: number): string {
  const y = Number(month.slice(0, 4));
  const mo = Number(month.slice(5, 7));
  const startYear = mo >= fyStartMonth ? y : y - 1;
  return fyStartMonth === 1 ? `FY ${startYear}` : `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

// ───────────────────────── Profit & loss ─────────────────────────

const PL_OPEX_GROUPS: Array<[string, string]> = [
  ['EMPLOYEE', 'Employee Expenses'],
  ['RENT_UTILITIES', 'Rent and Utilities'],
  ['MARKETING', 'Marketing Expenses'],
  ['TRANSPORTATION', 'Transportation Expenses'],
  ['ADMINISTRATIVE', 'Administrative Expenses'],
  ['OTHER_EXPENSE', 'Other Expenses'],
];

export interface PlStatement {
  rows: Array<{ label: string; amount: Dec; previous?: Dec; style?: 'section' | 'total' | 'subtotal'; indent?: number }>;
  totals: ReturnType<typeof plTotals>;
  previousTotals?: ReturnType<typeof plTotals>;
}

export async function profitAndLoss(companyId: string, from: string, to: string, method: AccountingMethod, compare: boolean): Promise<PlStatement> {
  const cur = await plByCategory(companyId, from, to, method);
  const prevRange = previousPeriod(from, to);
  const prev = compare ? await plByCategory(companyId, prevRange.from, prevRange.to, method) : null;
  const t = plTotals(cur);
  const pt = prev ? plTotals(prev) : undefined;
  const rows: PlStatement['rows'] = [];
  const groupSum = (cats: CategoryTotal[] | null, kind: string, groups: string[]) =>
    cats ? sum(cats.filter((c) => c.kind === kind && groups.includes(c.plGroup)).map((c) => c.amount)) : undefined;

  const section = (label: string) => rows.push({ label, amount: ZERO, style: 'section' });
  const group = (label: string, kind: 'INCOME' | 'EXPENSE', groups: string[]) => {
    const names = new Set([...cur, ...(prev ?? [])].filter((c) => c.kind === kind && groups.includes(c.plGroup)).map((c) => c.name));
    rows.push({ label, amount: groupSum(cur, kind, groups)!, previous: groupSum(prev, kind, groups), style: 'subtotal', indent: 1 });
    for (const name of [...names].sort()) {
      const find = (cats: CategoryTotal[] | null) => (cats ? sum(cats.filter((c) => c.kind === kind && c.name === name && groups.includes(c.plGroup)).map((c) => c.amount)) : undefined);
      rows.push({ label: name, amount: find(cur)!, previous: find(prev), indent: 2 });
    }
  };

  section('Revenue');
  group('Sales Revenue', 'INCOME', ['SALES_REVENUE']);
  group('Other Operating Income', 'INCOME', ['OTHER_OPERATING_INCOME']);
  rows.push({ label: 'Total Revenue', amount: t.totalIncome, previous: pt?.totalIncome, style: 'total' });
  section('Direct Costs');
  group('Cost of Goods Sold', 'EXPENSE', ['COST_OF_GOODS_SOLD']);
  group('Other Direct Costs', 'EXPENSE', ['DIRECT_COST']);
  rows.push({ label: 'Total Direct Costs', amount: t.directCosts, previous: pt?.directCosts, style: 'total' });
  rows.push({ label: 'Gross Profit', amount: t.grossProfit, previous: pt?.grossProfit, style: 'total' });
  section('Operating Expenses');
  for (const [g, label] of PL_OPEX_GROUPS) group(label, 'EXPENSE', [g]);
  rows.push({ label: 'Total Operating Expenses', amount: t.operatingExpenses, previous: pt?.operatingExpenses, style: 'total' });
  rows.push({ label: t.netProfit.gte(0) ? 'Net Profit' : 'Net Loss', amount: t.netProfit, previous: pt?.netProfit, style: 'total' });
  return { rows, totals: t, previousTotals: pt };
}

// ───────────────────────── Builder ─────────────────────────

export async function buildReport(companyId: string, key: string, p: ReportParams): Promise<Report> {
  if (!REPORTS[key]) throw new AppError(404, 'NOT_FOUND', 'Unknown report');
  if (p.to < p.from) throw badRequest('The end date cannot be before the start date');
  if (daysBetween(p.from, p.to) > 366 * 10) throw badRequest('Date range is too long (maximum 10 years)');
  const filters: Record<string, string> = {};
  const { company, method, meta } = await baseMeta(companyId, p, filters);
  const title = REPORTS[key].title;

  switch (key) {
    case 'daily': {
      if (daysBetween(p.from, p.to) > 366) throw badRequest('The daily report covers at most 366 days. Use the monthly report for longer periods.');
      return periodReport(key, await periodRows(companyId, p.from, p.to, 'day', method), meta);
    }
    case 'monthly': {
      const from = p.from.slice(0, 7) + '-01';
      const lastMonthEnd = addDays(nextMonthStart(p.to), -1);
      return periodReport(key, await periodRows(companyId, from, lastMonthEnd, 'month', method), { ...meta, from, to: lastMonthEnd });
    }
    case 'annual': {
      const from = p.from.slice(0, 7) + '-01';
      const to = addDays(nextMonthStart(p.to), -1);
      const months = await periodRows(companyId, from, to, 'month', method);
      const grouped = new Map<string, PeriodRow>();
      for (const r of months) {
        const label = fyLabel(r.period, company.fyStartMonth);
        const g = grouped.get(label);
        if (!g) grouped.set(label, { ...r, period: label });
        else {
          for (const k of FLOW_KEYS) g[k] = g[k].plus(r[k]);
          g.closing = r.closing;
        }
      }
      return periodReport(key, [...grouped.values()], { ...meta, from, to });
    }
    case 'profit-loss': {
      const st = await profitAndLoss(companyId, p.from, p.to, method, Boolean(p.compare));
      const prev = previousPeriod(p.from, p.to);
      const columns: ReportColumn[] = [{ key: 'label', label: 'Particulars' }, { key: 'amount', label: `${p.from} to ${p.to}`, type: 'money' }];
      if (p.compare) columns.push({ key: 'previous', label: `${prev.from} to ${prev.to}`, type: 'money' }, { key: 'change', label: 'Change', type: 'money' });
      return {
        key, title, columns, meta,
        note: 'Gross Profit = Total Revenue − Direct Costs. Net Profit = Total Recognised Income − Total Recognised Expenses. Profit is not the same as cash: see the Cash Flow Statement for money received and paid.',
        rows: st.rows.map((r) => ({
          label: '   '.repeat(r.indent ?? 0) + r.label,
          amount: r.style === 'section' ? '' : m(r.amount),
          ...(p.compare ? { previous: r.style === 'section' ? '' : m(r.previous ?? ZERO), change: r.style === 'section' ? '' : m(r.amount.minus(r.previous ?? ZERO)) } : {}),
          _style: r.style,
        })),
      };
    }
    case 'income':
    case 'expenses': {
      const kind = key === 'income' ? 'INCOME' : 'EXPENSE';
      const party = key === 'income' ? S`cu."name"` : S`su."name"`;
      const where = [
        S`l."companyId" = ${companyId}`, S`a."type"::text = ${kind}`, S`je."date" BETWEEN ${p.from}::date AND ${p.to}::date`,
      ];
      if (p.categoryId) { where.push(S`l."categoryId" = ${p.categoryId}`); filters.category = p.categoryId; }
      if (p.paymentMethod) { where.push(S`t."paymentMethod"::text = ${p.paymentMethod}`); filters.paymentMethod = p.paymentMethod; }
      if (p.customerId && kind === 'INCOME') where.push(S`l."customerId" = ${p.customerId}`);
      if (p.supplierId && kind === 'EXPENSE') where.push(S`l."supplierId" = ${p.supplierId}`);
      if (p.q) { where.push(S`(je."description" ILIKE ${'%' + p.q + '%'} OR t."number" ILIKE ${'%' + p.q + '%'} OR i."number" ILIKE ${'%' + p.q + '%'} OR t."reference" ILIKE ${'%' + p.q + '%'})`); filters.search = p.q; }
      const amount = kind === 'INCOME' ? S`l."credit" - l."debit"` : S`l."debit" - l."credit"`;
      const rows = await prisma.$queryRaw<{ date: Date; doc: string | null; category: string | null; party: string | null; description: string | null; method: string | null; reference: string | null; amount: Dec }[]>`
        SELECT je."date", COALESCE(t."number", i."number", je."number") AS doc, c."name" AS category, ${party} AS party,
               COALESCE(t."description", l."memo", je."description") AS description, t."paymentMethod"::text AS method, t."reference", ${amount} AS amount
        FROM "JournalEntryLine" l
        JOIN "JournalEntry" je ON je."id" = l."journalEntryId"
        JOIN "Account" a ON a."id" = l."accountId"
        LEFT JOIN "Transaction" t ON t."id" = je."transactionId"
        LEFT JOIN "Invoice" i ON i."id" = je."invoiceId"
        LEFT JOIN "TransactionCategory" c ON c."id" = l."categoryId"
        LEFT JOIN "Customer" cu ON cu."id" = l."customerId"
        LEFT JOIN "Supplier" su ON su."id" = l."supplierId"
        WHERE ${Prisma.join(where, ' AND ')}
        ORDER BY je."date", je."number"
        LIMIT 20000`;
      return {
        key, title, meta,
        note: 'Ledger listing (accrual): every posting to ' + (kind === 'INCOME' ? 'income' : 'expense') + ' accounts in the period. Reversals and refunds appear as negative amounts. Recorded expenses are not automatically tax-deductible.',
        columns: [
          { key: 'date', label: 'Date', type: 'date' }, { key: 'doc', label: 'Document' }, { key: 'category', label: 'Category' },
          { key: 'party', label: kind === 'INCOME' ? 'Customer' : 'Supplier' }, { key: 'description', label: 'Description' },
          { key: 'method', label: 'Payment Method' }, { key: 'reference', label: 'Reference' }, { key: 'amount', label: 'Amount', type: 'money' },
        ],
        rows: rows.map((r) => ({ date: fmtDate(r.date), doc: r.doc ?? '', category: r.category ?? 'Uncategorised', party: r.party ?? '', description: r.description ?? '', method: r.method ?? (kind === 'INCOME' ? 'INVOICE' : ''), reference: r.reference ?? '', amount: m(D(r.amount)) })),
        totals: { date: 'Total', amount: m(sum(rows.map((r) => r.amount))) },
      };
    }
    case 'cash-flow': {
      if (p.accountId) filters.account = p.accountId;
      const accountFilter = p.accountId ? S`AND x."accountId" = ${p.accountId}` : S``;
      const rows = await prisma.$queryRaw<{ type: string; direction: string; reversal: boolean; amount: Dec }[]>`
        SELECT t."type"::text AS type, x."direction"::text AS direction, t."isReversal" AS reversal, SUM(x."amount") AS amount
        FROM "AccountTransaction" x JOIN "Transaction" t ON t."id" = x."transactionId"
        WHERE x."companyId" = ${companyId} AND x."date" BETWEEN ${p.from}::date AND ${p.to}::date ${accountFilter}
        GROUP BY 1, 2, 3`;
      const opening = await openingCashBank(companyId, p.from, p.accountId);
      const LABEL: Record<string, [string, string]> = {
        INCOME: ['Income received', 'Income reversed'],
        EXPENSE: ['Expense reversals', 'Expenses paid'],
        RECEIPT: ['Receipts from customers', 'Customer receipts reversed'],
        SUPPLIER_PAYMENT: ['Supplier payments reversed', 'Payments to suppliers'],
        REFUND: ['Refund reversals', 'Refunds to customers'],
        TRANSFER: ['Transfers in', 'Transfers out'],
        ADJUSTMENT: ['Balance adjustments (increase)', 'Balance adjustments (decrease)'],
        OPENING_BALANCE: ['Opening balances introduced', 'Opening balances reversed'],
      };
      const agg = new Map<string, Dec>();
      for (const r of rows) {
        const label = LABEL[r.type]?.[r.direction === 'IN' ? 0 : 1] ?? r.type;
        const k = `${r.direction}|${label}`;
        agg.set(k, (agg.get(k) ?? ZERO).plus(D(r.amount)));
      }
      const pick = (dir: string) => [...agg.entries()].filter(([k]) => k.startsWith(dir + '|')).map(([k, v]) => ({ label: k.split('|')[1], amount: v })).sort((a, b) => a.label.localeCompare(b.label));
      const ins = pick('IN'), outs = pick('OUT');
      const inflow = sum(ins.map((r) => r.amount)), outflow = sum(outs.map((r) => r.amount));
      const out: ReportRow[] = [{ label: 'Opening cash and bank balance', amount: m(opening), _style: 'total' }, { label: 'Cash inflows', amount: '', _style: 'section' }];
      for (const r of ins) out.push({ label: '   ' + r.label, amount: m(r.amount) });
      out.push({ label: 'Total inflows', amount: m(inflow), _style: 'subtotal' }, { label: 'Cash outflows', amount: '', _style: 'section' });
      for (const r of outs) out.push({ label: '   ' + r.label, amount: m(r.amount) });
      out.push(
        { label: 'Total outflows', amount: m(outflow), _style: 'subtotal' },
        { label: 'Net cash flow', amount: m(inflow.minus(outflow)), _style: 'total' },
        { label: 'Closing cash and bank balance', amount: m(opening.plus(inflow).minus(outflow)), _style: 'total' },
      );
      return { key, title, meta, note: 'Direct method: actual movements on cash and bank accounts. Net cash flow is not the same as profit.', columns: [{ key: 'label', label: 'Particulars' }, { key: 'amount', label: 'Amount', type: 'money' }], rows: out };
    }
    case 'cash-accounts':
    case 'bank-accounts': {
      const subtype = key === 'cash-accounts' ? 'CASH' : 'BANK';
      const rows = await prisma.$queryRaw<{ id: string; name: string; bankName: string | null; masked: string | null; opening: Dec | null; inflow: Dec | null; outflow: Dec | null }[]>`
        SELECT a."id", a."name", a."bankName", a."accountNumberMasked" AS masked,
          SUM(CASE WHEN x."date" < ${p.from}::date THEN (CASE WHEN x."direction" = 'IN' THEN x."amount" ELSE -x."amount" END) ELSE 0 END) AS opening,
          SUM(CASE WHEN x."date" BETWEEN ${p.from}::date AND ${p.to}::date AND x."direction" = 'IN' THEN x."amount" ELSE 0 END) AS inflow,
          SUM(CASE WHEN x."date" BETWEEN ${p.from}::date AND ${p.to}::date AND x."direction" = 'OUT' THEN x."amount" ELSE 0 END) AS outflow
        FROM "Account" a LEFT JOIN "AccountTransaction" x ON x."accountId" = a."id"
        WHERE a."companyId" = ${companyId} AND a."subtype"::text = ${subtype}
        GROUP BY a."id", a."name", a."bankName", a."accountNumberMasked" ORDER BY a."name"`;
      const data = rows.map((r) => {
        const opening = D(r.opening), inflow = D(r.inflow), outflow = D(r.outflow);
        return { account: r.name + (r.bankName ? ` — ${r.bankName}` : '') + (r.masked ? ` (${r.masked})` : ''), opening, inflow, outflow, closing: opening.plus(inflow).minus(outflow) };
      });
      return {
        key, title, meta,
        note: 'Closing Balance = Opening Balance + Inflows − Outflows. Book balances from recorded entries; no live bank connection.',
        columns: [{ key: 'account', label: 'Account' }, { key: 'opening', label: 'Opening Balance', type: 'money' }, { key: 'inflow', label: 'Inflows', type: 'money' }, { key: 'outflow', label: 'Outflows', type: 'money' }, { key: 'closing', label: 'Closing Balance', type: 'money' }],
        rows: data.map((r) => ({ account: r.account, opening: m(r.opening), inflow: m(r.inflow), outflow: m(r.outflow), closing: m(r.closing) })),
        totals: { account: 'Total', opening: m(sum(data.map((r) => r.opening))), inflow: m(sum(data.map((r) => r.inflow))), outflow: m(sum(data.map((r) => r.outflow))), closing: m(sum(data.map((r) => r.closing))) },
      };
    }
    case 'online-payments': {
      const methods = ['UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'PAYMENT_GATEWAY', 'BANK_TRANSFER'];
      if (p.paymentMethod) filters.paymentMethod = p.paymentMethod;
      const list = await prisma.payment.findMany({
        where: {
          companyId,
          date: { gte: new Date(p.from), lte: new Date(p.to) },
          method: p.paymentMethod ? (p.paymentMethod as never) : { in: methods as never },
          ...(p.q ? { OR: [{ number: { contains: p.q, mode: 'insensitive' as const } }, { gatewayPaymentId: { contains: p.q, mode: 'insensitive' as const } }, { reference: { contains: p.q, mode: 'insensitive' as const } }] } : {}),
        },
        include: { customer: true, supplier: true, invoice: true },
        orderBy: [{ date: 'asc' }, { number: 'asc' }],
        take: 20000,
      });
      const ok = list.filter((x) => x.status === 'SUCCESS');
      return {
        key, title, meta,
        note: 'Totals include successful payments only. Pending, failed and reversed payments are listed for reference.',
        columns: [
          { key: 'date', label: 'Date', type: 'date' }, { key: 'number', label: 'Payment' }, { key: 'direction', label: 'Direction' }, { key: 'gateway', label: 'Gateway' },
          { key: 'ref', label: 'Reference ID' }, { key: 'party', label: 'Customer / Supplier' }, { key: 'invoice', label: 'Invoice' }, { key: 'method', label: 'Method' },
          { key: 'amount', label: 'Amount', type: 'money' }, { key: 'fee', label: 'Fee', type: 'money' }, { key: 'refunded', label: 'Refunded', type: 'money' },
          { key: 'status', label: 'Status' }, { key: 'refundStatus', label: 'Refund' }, { key: 'recon', label: 'Reconciliation' },
        ],
        rows: list.map((x) => ({
          date: fmtDate(x.date), number: x.number, direction: x.direction, gateway: x.gateway ?? '', ref: x.gatewayPaymentId ?? x.reference ?? '',
          party: x.customer?.name ?? x.supplier?.name ?? '', invoice: x.invoice?.number ?? '', method: x.method, amount: m(x.amount), fee: m(x.fee),
          refunded: m(x.refundedAmount), status: x.status, refundStatus: x.refundStatus, recon: x.reconStatus,
        })),
        totals: { date: 'Total (successful)', amount: m(sum(ok.map((x) => x.amount))), fee: m(sum(ok.map((x) => x.fee))), refunded: m(sum(ok.map((x) => x.refundedAmount))) },
      };
    }
    case 'receivables':
    case 'payables': {
      const isCust = key === 'receivables';
      const balances = await partyBalances(prisma, companyId, isCust ? 'customer' : 'supplier', p.to);
      const where = { companyId, ...(p.q ? { name: { contains: p.q, mode: 'insensitive' as const } } : {}) };
      const parties = isCust ? await prisma.customer.findMany({ where, orderBy: { name: 'asc' } }) : await prisma.supplier.findMany({ where, orderBy: { name: 'asc' } });
      const rows = parties.map((x) => ({ x, bal: balances.get(x.id) ?? ZERO })).filter((r) => !r.bal.isZero());
      const pos = await positionAsOf(companyId, p.to);
      return {
        key, title, meta: { ...meta, from: undefined, asOf: p.to },
        note: `Balances as of ${p.to}, from the ${isCust ? 'Accounts Receivable' : 'Accounts Payable'} ledger. Ledger control total: ${m(isCust ? pos.receivables : pos.payables)}. Negative = advance / credit balance.`,
        columns: [{ key: 'name', label: isCust ? 'Customer' : 'Supplier' }, { key: 'business', label: 'Business Name' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' }, { key: 'balance', label: 'Outstanding', type: 'money' }],
        rows: rows.map(({ x, bal }) => ({ name: x.name, business: x.businessName ?? '', phone: x.phone ?? '', email: x.email ?? '', balance: m(bal) })),
        totals: { name: 'Total', balance: m(sum(rows.map((r) => r.bal))) },
      };
    }
    case 'customer-transactions':
    case 'supplier-transactions': {
      const isCust = key === 'customer-transactions';
      const col = isCust ? S`l."customerId"` : S`l."supplierId"`;
      const subtype = isCust ? 'RECEIVABLE' : 'PAYABLE';
      const id = isCust ? p.customerId : p.supplierId;
      const where = [S`l."companyId" = ${companyId}`, S`a."subtype"::text = ${subtype}`, S`${col} IS NOT NULL`, S`je."date" BETWEEN ${p.from}::date AND ${p.to}::date`];
      if (id) where.push(S`${col} = ${id}`);
      if (p.q) where.push(S`(pt."name" ILIKE ${'%' + p.q + '%'} OR je."description" ILIKE ${'%' + p.q + '%'})`);
      const join = isCust ? S`JOIN "Customer" pt ON pt."id" = l."customerId"` : S`JOIN "Supplier" pt ON pt."id" = l."supplierId"`;
      const rows = await prisma.$queryRaw<{ date: Date; party: string; doc: string | null; description: string | null; debit: Dec; credit: Dec }[]>`
        SELECT je."date", pt."name" AS party, COALESCE(t."number", i."number", je."number") AS doc, je."description", l."debit", l."credit"
        FROM "JournalEntryLine" l
        JOIN "JournalEntry" je ON je."id" = l."journalEntryId"
        JOIN "Account" a ON a."id" = l."accountId"
        ${join}
        LEFT JOIN "Transaction" t ON t."id" = je."transactionId"
        LEFT JOIN "Invoice" i ON i."id" = je."invoiceId"
        WHERE ${Prisma.join(where, ' AND ')}
        ORDER BY pt."name", je."date", je."number" LIMIT 20000`;
      const inc = isCust ? 'debit' : 'credit', dec = isCust ? 'credit' : 'debit';
      return {
        key, title, meta,
        note: isCust ? 'Charges increase what the customer owes (invoices, refunds); settlements reduce it (receipts, cancellations).' : 'Charges increase what is owed to the supplier (bills); settlements reduce it (payments).',
        columns: [{ key: 'date', label: 'Date', type: 'date' }, { key: 'party', label: isCust ? 'Customer' : 'Supplier' }, { key: 'doc', label: 'Document' }, { key: 'description', label: 'Description' }, { key: 'charge', label: 'Charges', type: 'money' }, { key: 'settled', label: 'Settlements', type: 'money' }],
        rows: rows.map((r) => ({ date: fmtDate(r.date), party: r.party, doc: r.doc ?? '', description: r.description ?? '', charge: m(D(r[inc])), settled: m(D(r[dec])) })),
        totals: { date: 'Total', charge: m(sum(rows.map((r) => r[inc]))), settled: m(sum(rows.map((r) => r[dec]))), },
      };
    }
    case 'tax-summary': {
      const rows = await prisma.$queryRaw<{ month: string; subtype: string; amount: Dec }[]>`
        SELECT to_char(je."date", 'YYYY-MM') AS month, a."subtype"::text AS subtype,
               SUM(CASE WHEN a."subtype" = 'TAX_OUTPUT' THEN l."credit" - l."debit" ELSE l."debit" - l."credit" END) AS amount
        FROM "JournalEntryLine" l
        JOIN "JournalEntry" je ON je."id" = l."journalEntryId"
        JOIN "Account" a ON a."id" = l."accountId"
        WHERE l."companyId" = ${companyId} AND a."subtype" IN ('TAX_OUTPUT', 'TAX_INPUT') AND je."date" BETWEEN ${p.from}::date AND ${p.to}::date
        GROUP BY 1, 2 ORDER BY 1`;
      const months = [...new Set(rows.map((r) => r.month))].sort();
      const data = months.map((mo) => {
        const out = D(rows.find((r) => r.month === mo && r.subtype === 'TAX_OUTPUT')?.amount);
        const inp = D(rows.find((r) => r.month === mo && r.subtype === 'TAX_INPUT')?.amount);
        return { month: mo, out, inp, net: out.minus(inp) };
      });
      return {
        key, title, meta,
        note: 'Output tax = tax charged on income and invoices. Input tax = tax on expenses explicitly marked as recoverable. This is a bookkeeping summary, not a statutory return; confirm eligibility of input credits with your tax adviser.',
        columns: [{ key: 'month', label: 'Month' }, { key: 'out', label: 'Output Tax Collected', type: 'money' }, { key: 'inp', label: 'Input Tax Recoverable', type: 'money' }, { key: 'net', label: 'Net Tax Payable', type: 'money' }],
        rows: data.map((r) => ({ month: r.month, out: m(r.out), inp: m(r.inp), net: m(r.net) })),
        totals: { month: 'Total', out: m(sum(data.map((r) => r.out))), inp: m(sum(data.map((r) => r.inp))), net: m(sum(data.map((r) => r.net))) },
      };
    }
  }
  throw new AppError(404, 'NOT_FOUND', 'Unknown report');
}

function nextMonthStart(date: string): string {
  let y = Number(date.slice(0, 4));
  let mo = Number(date.slice(5, 7)) + 1;
  if (mo > 12) { mo = 1; y += 1; }
  return `${y}-${String(mo).padStart(2, '0')}-01`;
}
export { DIRECT_GROUPS };
