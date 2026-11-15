import { Router } from 'express';
import { prisma } from '../db';
import { D, money, sum } from '../lib/money';
import { previousPeriod } from '../lib/dates';
import { companyOf, h, requirePerm } from '../middleware/auth';
import {
  accountingMethodOf, cashSeries, paymentMethodBreakdown, pickGranularity, plByCategory, plSeries, plTotals, positionAsOf,
} from '../services/finance';
import { rangeOf } from './helpers';

export const dashboardRouter = Router();

// Small private cache for derived, read-only aggregates. Keyed by company + query; short TTL so new postings show up quickly.
const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 5000;
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (process.env.NODE_ENV === 'test') return fn();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) for (const [k, v] of cache) if (Date.now() - v.at > TTL_MS) cache.delete(k);
  return value;
}
export const clearDashboardCache = () => cache.clear();

dashboardRouter.get('/summary', requirePerm('reports.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const { from, to } = rangeOf(req);
  const data = await cached(`summary|${companyId}|${from}|${to}`, async () => {
    const method = await accountingMethodOf(companyId);
    const prev = previousPeriod(from, to);
    const [cats, prevCats, position, cash, pending, approvals, txnCount, anyEntry, company] = await Promise.all([
      plByCategory(companyId, from, to, method),
      plByCategory(companyId, prev.from, prev.to, method),
      positionAsOf(companyId, to),
      cashSeries(companyId, from, to, 'month'),
      prisma.payment.aggregate({ where: { companyId, status: 'PENDING' }, _sum: { amount: true }, _count: true }),
      prisma.transaction.count({ where: { companyId, status: 'PENDING_APPROVAL' } }),
      prisma.transaction.count({ where: { companyId, date: { gte: new Date(from), lte: new Date(to) } } }),
      prisma.journalEntry.count({ where: { companyId } }),
      prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { baseCurrency: true } }),
    ]);
    const t = plTotals(cats), p = plTotals(prevCats);
    return {
      range: { from, to }, previousRange: prev, currency: company.baseCurrency, accountingMethod: method,
      totalIncome: money(t.totalIncome), totalExpenses: money(t.totalExpenses), grossProfit: money(t.grossProfit), netProfit: money(t.netProfit),
      hasDirectCosts: !t.directCosts.isZero(),
      previous: { totalIncome: money(p.totalIncome), totalExpenses: money(p.totalExpenses), netProfit: money(p.netProfit) },
      cashBalance: money(position.cashBalance), bankBalance: money(position.bankBalance), receivables: money(position.receivables), payables: money(position.payables),
      onlineReceipts: money(sum(cash.map((c) => c.onlineIn))), onlinePaymentsOut: money(sum(cash.map((c) => c.onlineOut))),
      netCashFlow: money(sum(cash.map((c) => c.net))),
      pendingPayments: money(pending._sum.amount), pendingPaymentsCount: pending._count, pendingApprovals: approvals,
      transactionCount: txnCount, hasAnyData: anyEntry > 0,
    };
  });
  res.json({ data });
}));

dashboardRouter.get('/income-expenses', requirePerm('reports.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const { from, to } = rangeOf(req);
  const g = req.query.granularity === 'day' || req.query.granularity === 'month' ? req.query.granularity : pickGranularity(from, to);
  const data = await cached(`ie|${companyId}|${from}|${to}|${g}`, async () => {
    const series = await plSeries(companyId, from, to, g, await accountingMethodOf(companyId));
    return { granularity: g, series: series.map((s) => ({ bucket: s.bucket, income: money(s.income), expenses: money(s.expenses) })) };
  });
  res.json({ data });
}));

dashboardRouter.get('/profit-loss', requirePerm('reports.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const { from, to } = rangeOf(req);
  const g = req.query.granularity === 'day' || req.query.granularity === 'month' ? req.query.granularity : pickGranularity(from, to);
  const data = await cached(`pl|${companyId}|${from}|${to}|${g}`, async () => {
    const method = await accountingMethodOf(companyId);
    const [series, cats] = await Promise.all([plSeries(companyId, from, to, g, method), plByCategory(companyId, from, to, method)]);
    let running = D(0);
    return {
      granularity: g, accountingMethod: method,
      series: series.map((s) => { running = running.plus(s.profit); return { bucket: s.bucket, income: money(s.income), expenses: money(s.expenses), profit: money(s.profit), cumulative: money(running) }; }),
      expenseCategories: cats.filter((c) => c.kind === 'EXPENSE' && c.amount.gt(0)).sort((a, b) => b.amount.cmp(a.amount)).map((c) => ({ name: c.name, amount: money(c.amount) })),
      incomeCategories: cats.filter((c) => c.kind === 'INCOME' && c.amount.gt(0)).sort((a, b) => b.amount.cmp(a.amount)).map((c) => ({ name: c.name, amount: money(c.amount) })),
    };
  });
  res.json({ data });
}));

dashboardRouter.get('/cash-flow', requirePerm('reports.view'), h(async (req, res) => {
  const companyId = companyOf(req);
  const { from, to } = rangeOf(req);
  const g = req.query.granularity === 'day' || req.query.granularity === 'month' ? req.query.granularity : pickGranularity(from, to);
  const data = await cached(`cf|${companyId}|${from}|${to}|${g}`, async () => {
    const [series, methods] = await Promise.all([cashSeries(companyId, from, to, g), paymentMethodBreakdown(companyId, from, to)]);
    return {
      granularity: g,
      series: series.map((s) => ({ bucket: s.bucket, inflow: money(s.inflow), outflow: money(s.outflow), net: money(s.net) })),
      paymentMethods: methods.map((m) => ({ method: m.method, count: m.count, received: money(m.received), paid: money(m.paid), total: money(m.received.plus(m.paid)) })),
    };
  });
  res.json({ data });
}));
