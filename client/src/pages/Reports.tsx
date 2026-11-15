import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, FileBarChart, Printer, Search } from 'lucide-react';
import { api, download, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAccounts, useCategories, useDebounced, useParties } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { formatBucket, formatDate, formatDateTime, formatMoney, METHOD_LABELS, methodLabel } from '../lib/format';
import { DateRangePicker, useDateRange } from '../components/DateRangePicker';
import { Button, Card, Checkbox, cn, EmptyState, ErrorState, Input, Loading, PageHeader, Select } from '../components/ui';

interface ReportDef { key: string; title: string; description: string; filters: string[] }
interface Column { key: string; label: string; type?: 'text' | 'money' | 'date' | 'number' }
interface Report {
  key: string; title: string; note?: string; columns: Column[]; rows: Array<Record<string, string> & { _style?: 'section' | 'total' | 'subtotal' }>; totals?: Record<string, string>;
  meta: { companyName: string; currency: string; from?: string; to?: string; asOf?: string; generatedAt: string; basis: string };
}

const GROUPS: Array<[string, string[]]> = [
  ['Financial summaries', ['daily', 'monthly', 'annual', 'profit-loss', 'cash-flow']],
  ['Income and expenses', ['income', 'expenses', 'tax-summary']],
  ['Cash, bank and payments', ['cash-accounts', 'bank-accounts', 'online-payments']],
  ['Customers and suppliers', ['receivables', 'payables', 'customer-transactions', 'supplier-transactions']],
];

function ReportIndex({ defs }: { defs: ReportDef[] }) {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  return (
    <>
      <PageHeader title="Reports" description="Every report is built from posted ledger entries for the period you choose, and can be exported or printed." />
      <div className="space-y-6">
        {GROUPS.map(([group, keys]) => (
          <section key={group}>
            <h2 className="mb-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{group}</h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {keys.map((k) => byKey.get(k)).filter((d): d is ReportDef => Boolean(d)).map((d) => (
                <Link key={d.key} to={`/reports/${d.key}`} className="rounded-lg">
                  <Card className="flex h-full items-start gap-3 p-4 transition-shadow hover:shadow-md">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-navy-50 text-navy-700"><FileBarChart className="h-4 w-4" aria-hidden /></span>
                    <span><span className="block text-sm font-semibold text-slate-900">{d.title}</span><span className="mt-0.5 block text-xs text-slate-500">{d.description}</span></span>
                  </Card>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}

function cell(col: Column, value: string | undefined, currency: string, key: string) {
  if (value === undefined || value === '') return '';
  if (col.type === 'money') return formatMoney(value, currency);
  if (col.type === 'date') return formatDate(value);
  if (col.key === 'period' || col.key === 'month') return /^\d{4}-\d{2}(-\d{2})?$/.test(value) ? (value.length === 10 ? formatDate(value) : formatBucket(value)) : value;
  if (col.key === 'method' && key !== 'online-payments') return value === 'INVOICE' ? 'Invoice' : methodLabel(value);
  if (col.key === 'method') return methodLabel(value);
  return value;
}

function ReportView({ def }: { def: ReportDef }) {
  const { can } = useAuth();
  const toast = useToast();
  const { range } = useDateRange();
  const has = (f: string) => def.filters.includes(f);
  const [filters, setFilters] = useState({ categoryId: '', accountId: '', paymentMethod: '', customerId: '', supplierId: '' });
  const [compare, setCompare] = useState(false);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [exporting, setExporting] = useState('');
  const categories = useCategories(has('categoryId'));
  const accounts = useAccounts(has('accountId'));
  const customers = useParties('customers', has('customerId'));
  const suppliers = useParties('suppliers', has('supplierId'));

  const query = { ...range, ...Object.fromEntries(Object.entries(filters).filter(([k]) => has(k))), q: has('q') ? q : '', compare: has('compare') && compare ? 1 : undefined };
  const report = useQuery({ queryKey: ['report', def.key, query], queryFn: async () => (await api.get<Report>(`/reports/${def.key}`, query)).data, placeholderData: keepPreviousData });
  const r = report.data;
  const doExport = async (format: string) => {
    setExporting(format);
    try { await download(`/reports/${def.key}`, { ...query, format }, `${def.key}.${format}`); } catch (e) { toast.error(errorMessage(e)); } finally { setExporting(''); }
  };
  const catType = def.key === 'income' ? 'INCOME' : 'EXPENSE';
  const methodOptions = def.key === 'online-payments' ? ['UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'PAYMENT_GATEWAY', 'BANK_TRANSFER'] : Object.keys(METHOD_LABELS);
  const wide = (r?.columns.length ?? 0) > 8;

  return (
    <>
      <Link to="/reports" className="no-print mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> All reports</Link>
      <PageHeader
        title={def.title}
        description={def.description}
        actions={
          <>
            <Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()} disabled={!r}>Print</Button>
            {can('reports.export') && (['csv', 'xlsx', 'pdf'] as const).map((f) => <Button key={f} variant="secondary" loading={exporting === f} disabled={!r} icon={<Download className="h-4 w-4" />} onClick={() => doExport(f)}>{f === 'xlsx' ? 'Excel' : f.toUpperCase()}</Button>)}
          </>
        }
      />
      <Card className="no-print mb-5 flex flex-wrap items-center gap-3 p-4">
        <DateRangePicker />
        {has('categoryId') && <Select aria-label="Category" className="w-auto" value={filters.categoryId} onChange={(e) => setFilters({ ...filters, categoryId: e.target.value })}><option value="">All categories</option>{(categories.data ?? []).filter((c) => c.type === catType).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
        {has('accountId') && <Select aria-label="Account" className="w-auto" value={filters.accountId} onChange={(e) => setFilters({ ...filters, accountId: e.target.value })}><option value="">All cash and bank accounts</option>{(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}
        {has('paymentMethod') && <Select aria-label="Payment method" className="w-auto" value={filters.paymentMethod} onChange={(e) => setFilters({ ...filters, paymentMethod: e.target.value })}><option value="">All payment methods</option>{methodOptions.map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}</Select>}
        {has('customerId') && <Select aria-label="Customer" className="w-auto" value={filters.customerId} onChange={(e) => setFilters({ ...filters, customerId: e.target.value })}><option value="">All customers</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
        {has('supplierId') && <Select aria-label="Supplier" className="w-auto" value={filters.supplierId} onChange={(e) => setFilters({ ...filters, supplierId: e.target.value })}><option value="">All suppliers</option>{(suppliers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
        {has('q') && (
          <div className="relative w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input aria-label="Search within report" placeholder="Search…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        )}
        {has('compare') && <Checkbox label="Compare with previous period" checked={compare} onChange={setCompare} />}
      </Card>

      <Card className={cn('print-area', report.isPlaceholderData && 'opacity-60')}>
        {report.isLoading ? <Loading label="Building report…" /> : report.isError || !r ? <ErrorState error={report.error} onRetry={() => report.refetch()} /> : (
          <>
            <div className="border-b border-slate-200 px-5 py-4">
              <p className="text-base font-semibold text-slate-900">{r.meta.companyName}</p>
              <p className="text-sm font-medium text-slate-700">{r.title}</p>
              <p className="mt-1 text-xs text-slate-500">
                {r.meta.asOf ? `As of ${formatDate(r.meta.asOf)}` : `Period: ${formatDate(r.meta.from)} to ${formatDate(r.meta.to)}`} · Currency: {r.meta.currency} · {r.meta.basis} · Generated {formatDateTime(r.meta.generatedAt)}
              </p>
            </div>
            {r.rows.length === 0 ? <EmptyState title="No records for this period" message="There is nothing to report for the selected dates and filters. Try a wider date range." /> : (
              <div className="table-wrap">
                <table className={cn('table', wide && 'text-xs')}>
                  <thead className="bg-slate-50"><tr>{r.columns.map((c) => <th key={c.key} className={cn('th', (c.type === 'money' || c.type === 'number') && 'text-right', wide && 'px-2')}>{c.label}</th>)}</tr></thead>
                  <tbody>
                    {r.rows.map((row, i) => (
                      <tr key={i} className={cn(row._style === 'section' && 'bg-slate-50', row._style === 'total' && 'bg-slate-50/60')}>
                        {r.columns.map((c) => (
                          <td key={c.key} className={cn('td whitespace-pre', wide && 'px-2 text-xs', (c.type === 'money' || c.type === 'number') && 'num', row._style && 'font-semibold text-slate-900', row._style === 'section' && 'text-xs uppercase tracking-wide text-slate-600', c.type === 'money' && Number(row[c.key]) < 0 && 'text-rose-700', c.key === 'description' && 'max-w-[280px] truncate whitespace-nowrap')}>
                            {cell(c, row[c.key], r.meta.currency, r.key)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  {r.totals && (
                    <tfoot className="border-t-2 border-slate-300 bg-slate-100">
                      <tr>{r.columns.map((c) => <td key={c.key} className={cn('td font-semibold text-slate-900', wide && 'px-2 text-xs', (c.type === 'money' || c.type === 'number') && 'num')}>{c.type === 'money' ? cell(c, r.totals![c.key], r.meta.currency, r.key) : r.totals![c.key] ?? ''}</td>)}</tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
            {r.note && <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">{r.note}</p>}
          </>
        )}
      </Card>
    </>
  );
}

export default function Reports() {
  const { key } = useParams();
  const defs = useQuery({ queryKey: ['report-defs'], queryFn: async () => (await api.get<ReportDef[]>('/reports')).data, staleTime: Infinity });
  if (defs.isLoading) return <Loading />;
  if (defs.isError || !defs.data) return <Card><ErrorState error={defs.error} onRetry={() => defs.refetch()} /></Card>;
  if (!key) return <ReportIndex defs={defs.data} />;
  const def = defs.data.find((d) => d.key === key);
  if (!def) return <EmptyState title="Report not found" action={<Link to="/reports"><Button variant="secondary">All reports</Button></Link>} />;
  return <ReportView key={def.key} def={def} />;
}
