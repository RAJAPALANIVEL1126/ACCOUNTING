import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { ArrowDownRight, ArrowUpRight, Banknote, BarChart3, Clock, CreditCard, HandCoins, Landmark, PiggyBank, Receipt, TrendingDown, TrendingUp, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatBucket, formatCompact, formatDate, formatMoney, methodLabel } from '../lib/format';
import { DateRangePicker, useDateRange } from '../components/DateRangePicker';
import { Badge, Button, Card, CardHeader, cn, EmptyState, ErrorState, Loading, Notice, PageHeader, Spinner } from '../components/ui';

interface Summary {
  currency: string; accountingMethod: 'ACCRUAL' | 'CASH'; totalIncome: string; totalExpenses: string; grossProfit: string; netProfit: string; hasDirectCosts: boolean;
  previous: { totalIncome: string; totalExpenses: string; netProfit: string }; previousRange: { from: string; to: string };
  cashBalance: string; bankBalance: string; receivables: string; payables: string; onlineReceipts: string; netCashFlow: string;
  pendingPayments: string; pendingPaymentsCount: number; pendingApprovals: number; transactionCount: number; hasAnyData: boolean;
}
interface Series<T> { granularity: 'day' | 'month'; series: T[] }
interface PlData extends Series<{ bucket: string; income: string; expenses: string; profit: string; cumulative: string }> { expenseCategories: Array<{ name: string; amount: string }>; incomeCategories: Array<{ name: string; amount: string }> }
interface CfData extends Series<{ bucket: string; inflow: string; outflow: string; net: string }> { paymentMethods: Array<{ method: string; count: number; received: string; paid: string; total: string }> }

const COLORS = { income: '#059669', expense: '#E11D48', profit: '#2563EB', inflow: '#0EA5E9', outflow: '#F59E0B', grid: '#E2E8F0', axis: '#64748B' };
const PIE = ['#2563EB', '#0EA5E9', '#059669', '#F59E0B', '#E11D48', '#7C3AED', '#0F766E', '#DB2777', '#64748B', '#CA8A04'];

function delta(cur: string, prev: string): { pct: number; up: boolean } | null {
  const c = Number(cur), p = Number(prev);
  if (!p) return null;
  return { pct: Math.abs(((c - p) / Math.abs(p)) * 100), up: c >= p };
}

function Kpi({ label, value, icon: Icon, tone, hint, change, goodWhenUp = true, to }: { label: string; value: string; icon: LucideIcon; tone: string; hint?: ReactNode; change?: { pct: number; up: boolean } | null; goodWhenUp?: boolean; to?: string }) {
  const { currency } = useAuth();
  const negative = Number(value) < 0;
  const body = (
    <Card className={cn('h-full p-4', to && 'transition-shadow hover:shadow-md')}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-md', tone)}><Icon className="h-4 w-4" aria-hidden /></span>
      </div>
      <p className={cn('mt-2 truncate text-xl font-semibold tabular-nums tracking-tight text-slate-900', negative && 'text-rose-700')} title={formatMoney(value, currency)}>{formatMoney(value, currency)}</p>
      <div className="mt-1 flex min-h-[18px] items-center gap-1.5 text-xs text-slate-500">
        {change && (
          <span className={cn('inline-flex items-center font-medium', change.up === goodWhenUp ? 'text-emerald-700' : 'text-rose-700')}>
            {change.up ? <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /> : <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />}
            {change.pct >= 1000 ? '999+' : change.pct.toFixed(1)}%
          </span>
        )}
        <span className="truncate">{change ? 'vs previous period' : hint}</span>
      </div>
    </Card>
  );
  return to ? <Link to={to} className="block rounded-lg">{body}</Link> : body;
}

function ChartCard({ title, description, loading, error, empty, emptyText, onRetry, actions, children }: { title: string; description?: string; loading: boolean; error: unknown; empty: boolean; emptyText: string; onRetry: () => void; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card className="flex flex-col">
      <CardHeader title={title} description={description} actions={actions} />
      <div className="min-h-[280px] flex-1 p-3 sm:p-4">
        {loading ? <div className="flex h-[260px] items-center justify-center"><Spinner /></div>
          : error ? <ErrorState error={error} onRetry={onRetry} />
          : empty ? <EmptyState icon={<BarChart3 className="h-5 w-5" />} title="No data for this period" message={emptyText} />
          : <div className="h-[260px] w-full">{children}</div>}
      </div>
    </Card>
  );
}

export default function Dashboard() {
  const { currency, can, company } = useAuth();
  const { range } = useDateRange();
  const [granularity, setGranularity] = useState<'auto' | 'day' | 'month'>('auto');
  const params = { from: range.from, to: range.to, ...(granularity === 'auto' ? {} : { granularity }) };

  const summary = useQuery({ queryKey: ['dashboard', 'summary', range], queryFn: async () => (await api.get<Summary>('/dashboard/summary', range)).data });
  const pl = useQuery({ queryKey: ['dashboard', 'pl', params], queryFn: async () => (await api.get<PlData>('/dashboard/profit-loss', params)).data });
  const cf = useQuery({ queryKey: ['dashboard', 'cf', params], queryFn: async () => (await api.get<CfData>('/dashboard/cash-flow', params)).data });

  const money = (v: unknown) => formatMoney(v as string, currency);
  const axisMoney = (v: number) => formatCompact(v, currency);
  const tooltip = { formatter: (v: unknown, name: unknown) => [money(v), String(name)] as [string, string], labelFormatter: (l: unknown) => formatBucket(String(l)), contentStyle: { borderRadius: 8, border: '1px solid #E2E8F0', fontSize: 12 } };
  const axis = { tick: { fontSize: 11, fill: COLORS.axis }, tickLine: false, axisLine: { stroke: COLORS.grid } };

  const num = <T extends object>(rows: T[] | undefined) => (rows ?? []).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'bucket' || k === 'name' || k === 'method' ? v : Number(v)])) as Record<string, string | number>);
  const plRows = num(pl.data?.series);
  const cfRows = num(cf.data?.series);
  const noPl = !plRows.some((r) => r.income !== 0 || r.expenses !== 0);
  const noCf = !cfRows.some((r) => r.inflow !== 0 || r.outflow !== 0);
  const expenseCats = (pl.data?.expenseCategories ?? []).map((c) => ({ name: c.name, value: Number(c.amount) }));
  const pieData = expenseCats.length > 8 ? [...expenseCats.slice(0, 7), { name: 'Other categories', value: expenseCats.slice(7).reduce((a, c) => a + c.value, 0) }] : expenseCats;
  const methods = (cf.data?.paymentMethods ?? []).map((m) => ({ name: methodLabel(m.method), Received: Number(m.received), Paid: Number(m.paid), count: m.count }));
  const unit = (pl.data?.granularity ?? 'day') === 'day' ? 'Daily' : 'Monthly';
  const s = summary.data;

  const toggle = (
    <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-xs" role="group" aria-label="Chart interval">
      {(['auto', 'day', 'month'] as const).map((g) => (
        <button key={g} onClick={() => setGranularity(g)} aria-pressed={granularity === g} className={cn('rounded px-2 py-1 font-medium capitalize', granularity === g ? 'bg-navy-800 text-white' : 'text-slate-600 hover:bg-slate-100')}>{g === 'day' ? 'Daily' : g === 'month' ? 'Monthly' : 'Auto'}</button>
      ))}
    </div>
  );

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={<>{company?.name} · {range.from === range.to ? formatDate(range.from) : `${formatDate(range.from)} – ${formatDate(range.to)}`}{s && <> · <Badge tone="blue">{s.accountingMethod === 'ACCRUAL' ? 'Accrual basis' : 'Cash basis'}</Badge></>}</>}
        actions={<DateRangePicker />}
      />

      {summary.isLoading ? <Loading label="Loading financial overview…" /> : summary.isError || !s ? <Card><ErrorState error={summary.error} onRetry={() => summary.refetch()} /></Card> : (
        <>
          {!s.hasAnyData && (
            <Card className="mb-5">
              <EmptyState
                icon={<Receipt className="h-5 w-5" />}
                title="No transactions recorded yet"
                message="Your dashboard shows real figures from your books. Record your first income or expense, or set an opening balance on a cash or bank account, and the numbers will appear here."
                action={can('transactions.create') ? <div className="flex flex-wrap justify-center gap-2"><Link to="/income"><Button>Record income</Button></Link><Link to="/expenses"><Button variant="secondary">Record expense</Button></Link></div> : undefined}
              />
            </Card>
          )}
          {s.pendingApprovals > 0 && can('expenses.approve') && (
            <div className="mb-4"><Notice tone="amber"><b>{s.pendingApprovals}</b> expense{s.pendingApprovals === 1 ? '' : 's'} awaiting approval. <Link className="font-semibold underline" to="/expenses?approval=PENDING">Review now</Link></Notice></div>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <Kpi label="Total Income" value={s.totalIncome} icon={TrendingUp} tone="bg-emerald-50 text-emerald-700" change={delta(s.totalIncome, s.previous.totalIncome)} hint="In selected period" to="/income" />
            <Kpi label="Total Expenses" value={s.totalExpenses} icon={TrendingDown} tone="bg-rose-50 text-rose-700" change={delta(s.totalExpenses, s.previous.totalExpenses)} goodWhenUp={false} hint="In selected period" to="/expenses" />
            <Kpi label="Gross Profit" value={s.grossProfit} icon={PiggyBank} tone="bg-sky-50 text-sky-700" hint={s.hasDirectCosts ? 'Revenue − direct costs' : 'No direct costs recorded'} />
            <Kpi label={Number(s.netProfit) < 0 ? 'Net Loss' : 'Net Profit'} value={s.netProfit} icon={BarChart3} tone="bg-brand-50 text-brand-700" change={delta(s.netProfit, s.previous.netProfit)} hint="Income − expenses" to="/reports/profit-loss" />
            <Kpi label="Total Cash Balance" value={s.cashBalance} icon={Banknote} tone="bg-amber-50 text-amber-700" hint={`As of ${formatDate(range.to)}`} to="/cash" />
            <Kpi label="Total Bank Balance" value={s.bankBalance} icon={Landmark} tone="bg-indigo-50 text-indigo-700" hint={`As of ${formatDate(range.to)}`} to="/bank" />
            <Kpi label="Total Receivables" value={s.receivables} icon={HandCoins} tone="bg-teal-50 text-teal-700" hint="Owed by customers" to="/reports/receivables" />
            <Kpi label="Total Payables" value={s.payables} icon={Wallet} tone="bg-orange-50 text-orange-700" hint="Owed to suppliers" to="/reports/payables" />
            <Kpi label="Total Online Payments" value={s.onlineReceipts} icon={CreditCard} tone="bg-violet-50 text-violet-700" hint="Received online in period" to="/payments" />
            <Kpi label="Pending Payments" value={s.pendingPayments} icon={Clock} tone="bg-slate-100 text-slate-600" hint={`${s.pendingPaymentsCount} awaiting confirmation`} to="/payments?status=PENDING" />
          </div>
          <p className="mt-2 text-xs text-slate-500">Profit is not the same as cash. Net cash flow for this period: <b className={cn('tabular-nums', Number(s.netCashFlow) < 0 ? 'text-rose-700' : 'text-slate-700')}>{money(s.netCashFlow)}</b> (money received minus money paid across cash and bank accounts).</p>
        </>
      )}

      <div className="mt-6 grid gap-5 xl:grid-cols-2">
        <ChartCard title={`${unit} Income vs Expenses`} description="Recognised income and expenses per period" loading={pl.isLoading} error={pl.error} empty={noPl} emptyText="Income and expenses recorded in this date range will be compared here." onRetry={() => pl.refetch()} actions={toggle}>
          <ResponsiveContainer>
            <BarChart data={plRows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={COLORS.grid} vertical={false} />
              <XAxis dataKey="bucket" tickFormatter={formatBucket} minTickGap={18} {...axis} />
              <YAxis tickFormatter={axisMoney} width={62} {...axis} />
              <Tooltip {...tooltip} cursor={{ fill: '#F1F5F9' }} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="income" name="Income" fill={COLORS.income} radius={[2, 2, 0, 0]} maxBarSize={28} />
              <Bar dataKey="expenses" name="Expenses" fill={COLORS.expense} radius={[2, 2, 0, 0]} maxBarSize={28} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Profit and Loss Trend" description="Profit or loss per period, with the running total" loading={pl.isLoading} error={pl.error} empty={noPl} emptyText="Profit and loss will be charted once income or expenses exist in this period." onRetry={() => pl.refetch()}>
          <ResponsiveContainer>
            <ComposedChart data={plRows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={COLORS.grid} vertical={false} />
              <XAxis dataKey="bucket" tickFormatter={formatBucket} minTickGap={18} {...axis} />
              <YAxis tickFormatter={axisMoney} width={62} {...axis} />
              <Tooltip {...tooltip} cursor={{ fill: '#F1F5F9' }} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine y={0} stroke="#94A3B8" />
              <Bar dataKey="profit" name="Profit / Loss" maxBarSize={28} radius={[2, 2, 0, 0]}>
                {plRows.map((r, i) => <Cell key={i} fill={Number(r.profit) < 0 ? COLORS.expense : COLORS.income} />)}
              </Bar>
              <Line type="monotone" dataKey="cumulative" name="Cumulative" stroke={COLORS.profit} strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Cash Flow" description="Money in and out of cash and bank accounts" loading={cf.isLoading} error={cf.error} empty={noCf} emptyText="Receipts and payments on your cash and bank accounts will appear here." onRetry={() => cf.refetch()}>
          <ResponsiveContainer>
            <ComposedChart data={cfRows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={COLORS.grid} vertical={false} />
              <XAxis dataKey="bucket" tickFormatter={formatBucket} minTickGap={18} {...axis} />
              <YAxis tickFormatter={axisMoney} width={62} {...axis} />
              <Tooltip {...tooltip} cursor={{ fill: '#F1F5F9' }} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine y={0} stroke="#94A3B8" />
              <Bar dataKey="inflow" name="Incoming" fill={COLORS.inflow} radius={[2, 2, 0, 0]} maxBarSize={28} />
              <Bar dataKey="outflow" name="Outgoing" fill={COLORS.outflow} radius={[2, 2, 0, 0]} maxBarSize={28} />
              <Line type="monotone" dataKey="net" name="Net cash flow" stroke="#0F1E3D" strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Revenue Trend" description="Recognised revenue across the selected period" loading={pl.isLoading} error={pl.error} empty={!plRows.some((r) => r.income !== 0)} emptyText="Revenue recorded in this date range will be charted here." onRetry={() => pl.refetch()}>
          <ResponsiveContainer>
            <AreaChart data={plRows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="rev" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={COLORS.profit} stopOpacity={0.25} /><stop offset="100%" stopColor={COLORS.profit} stopOpacity={0.02} /></linearGradient>
              </defs>
              <CartesianGrid stroke={COLORS.grid} vertical={false} />
              <XAxis dataKey="bucket" tickFormatter={formatBucket} minTickGap={18} {...axis} />
              <YAxis tickFormatter={axisMoney} width={62} {...axis} />
              <Tooltip {...tooltip} />
              <Area type="monotone" dataKey="income" name="Revenue" stroke={COLORS.profit} strokeWidth={2} fill="url(#rev)" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Expenses by Category" description="Share of recognised expenses" loading={pl.isLoading} error={pl.error} empty={pieData.length === 0} emptyText="Expense categories will be broken down here once expenses are recorded." onRetry={() => pl.refetch()}>
          <ResponsiveContainer>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" innerRadius="48%" outerRadius="78%" paddingAngle={1.5} stroke="#fff">
                {pieData.map((_, i) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
              </Pie>
              <Tooltip formatter={(v: unknown, name: unknown) => { const total = pieData.reduce((a, c) => a + c.value, 0); return [`${money(v)} (${total ? ((Number(v) / total) * 100).toFixed(1) : '0'}%)`, String(name)] as [string, string]; }} contentStyle={tooltip.contentStyle} />
              <Legend layout="vertical" align="right" verticalAlign="middle" iconType="circle" wrapperStyle={{ fontSize: 12, maxWidth: '45%' }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Payment Methods" description="Money received and paid, by payment method (transfers between own accounts excluded)" loading={cf.isLoading} error={cf.error} empty={methods.length === 0} emptyText="The mix of cash, UPI, card and bank payments will appear here." onRetry={() => cf.refetch()}>
          <ResponsiveContainer>
            <BarChart data={methods} layout="vertical" margin={{ top: 6, right: 12, left: 8, bottom: 0 }}>
              <CartesianGrid stroke={COLORS.grid} horizontal={false} />
              <XAxis type="number" tickFormatter={axisMoney} {...axis} />
              <YAxis type="category" dataKey="name" width={104} {...axis} />
              <Tooltip formatter={tooltip.formatter} contentStyle={tooltip.contentStyle} cursor={{ fill: '#F1F5F9' }} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Received" fill={COLORS.income} radius={[0, 2, 2, 0]} maxBarSize={16} />
              <Bar dataKey="Paid" fill={COLORS.expense} radius={[0, 2, 2, 0]} maxBarSize={16} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </>
  );
}
