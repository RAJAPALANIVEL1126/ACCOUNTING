import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDownUp, ArrowLeftRight, Download, Paperclip, Plus, Search, TrendingDown, TrendingUp } from 'lucide-react';
import { api, download, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAccounts, useCategories, useDebounced } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { formatDate, METHOD_LABELS, methodLabel, TYPE_LABELS, typeLabel } from '../lib/format';
import { DateRangePicker, useDateRange } from '../components/DateRangePicker';
import { Button, Card, cn, EmptyState, ErrorState, Input, Loading, Money, PageHeader, Pagination, Select, StatusBadge } from '../components/ui';
import { TransactionFormModal } from '../components/TransactionForms';
import type { FormKind } from '../components/TransactionForms';
import { TransactionDetailModal } from '../components/TransactionDetail';

export interface TxnRow {
  id: string; number: string; type: string; status: string; date: string; amount: string; taxAmount: string; totalAmount: string; category: string | null; paymentMethod: string;
  sourceAccount: string | null; destinationAccount: string | null; customer: string | null; supplier: string | null; reference: string | null; description: string | null;
  isReversal: boolean; onCredit: boolean; outstanding: string; approvalStatus: string | null; hasAttachment: boolean; createdBy: string | null;
}
interface Meta { page: number; pageSize: number; total: number; totals: { amount: string; taxAmount: string; totalAmount: string } }

const COPY = {
  all: { title: 'Transactions', description: 'Every posting in one register: income, expenses, transfers, receipts, payments and adjustments.', path: '/transactions' },
  income: { title: 'Income', description: 'Money received for sales and services. Invoiced sales are managed under Invoices.', path: '/income' },
  expense: { title: 'Expenses', description: 'Business spending, paid immediately or recorded on credit as a supplier bill.', path: '/expenses' },
};
const STATUSES = ['POSTED', 'PENDING_APPROVAL', 'REVERSED', 'REJECTED'];

/** Signed presentation: money in is positive, money out negative, relative to the business. */
const sign = (r: TxnRow) => {
  const inflow = ['INCOME', 'RECEIPT'].includes(r.type) || (['ADJUSTMENT', 'OPENING_BALANCE'].includes(r.type) && Boolean(r.destinationAccount));
  const neutral = r.type === 'TRANSFER';
  return neutral ? 0 : inflow !== r.isReversal ? 1 : -1;
};

export default function Transactions({ mode }: { mode: 'all' | 'income' | 'expense' }) {
  const copy = COPY[mode];
  const { can } = useAuth();
  const toast = useToast();
  const { range } = useDateRange();
  const [params, setParams] = useSearchParams();
  const accounts = useAccounts();
  const categories = useCategories();

  const [filters, setFilters] = useState({ type: '', status: '', paymentMethod: '', accountId: '', categoryId: '', approval: params.get('approval') ?? '' });
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [sort, setSort] = useState<{ field: 'date' | 'amount' | 'number'; order: 'asc' | 'desc' }>({ field: 'date', order: 'desc' });
  const [page, setPage] = useState(1);
  const [form, setForm] = useState<FormKind | null>(null);
  const [detail, setDetail] = useState<string | null>(params.get('open'));
  const [exporting, setExporting] = useState('');

  useEffect(() => { setPage(1); }, [filters, q, range.from, range.to, sort]);
  const pendingOnly = filters.approval === 'PENDING';
  // The approval queue is not date-bound: an old pending expense must still be visible.
  const query = { ...(pendingOnly ? {} : range), ...filters, q, sort: sort.field, order: sort.order, page, pageSize: 25 };
  const list = useQuery({
    queryKey: ['transactions', mode, query],
    queryFn: () => api.get<TxnRow[], Meta>(copy.path, query),
    placeholderData: keepPreviousData,
  });

  const setFilter = (k: keyof typeof filters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const toggleSort = (field: 'date' | 'amount' | 'number') => setSort((s) => ({ field, order: s.field === field && s.order === 'desc' ? 'asc' : 'desc' }));
  const closeDetail = () => { setDetail(null); if (params.get('open')) { params.delete('open'); setParams(params, { replace: true }); } };
  const doExport = async (format: 'csv' | 'xlsx' | 'pdf') => {
    setExporting(format);
    try { await download(copy.path, { ...query, page: undefined, pageSize: undefined, format }, `transactions.${format}`); }
    catch (e) { toast.error(errorMessage(e)); }
    finally { setExporting(''); }
  };

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const filtered = Boolean(q || Object.values(filters).some(Boolean));
  const cats = (categories.data ?? []).filter((c) => (mode === 'all' ? true : c.type === (mode === 'income' ? 'INCOME' : 'EXPENSE')));
  const canCreate = can('transactions.create');
  const SortTh = ({ field, label, className }: { field: 'date' | 'amount' | 'number'; label: string; className?: string }) => (
    <th className={cn('th', className)} aria-sort={sort.field === field ? (sort.order === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button className="inline-flex items-center gap-1 uppercase hover:text-slate-800" onClick={() => toggleSort(field)}>{label}<ArrowDownUp className={cn('h-3 w-3', sort.field === field ? 'text-brand-600' : 'text-slate-300')} aria-hidden /></button>
    </th>
  );

  return (
    <>
      <PageHeader
        title={copy.title}
        description={copy.description}
        actions={canCreate && (
          <>
            {mode !== 'expense' && <Button icon={<TrendingUp className="h-4 w-4" />} variant={mode === 'all' ? 'secondary' : 'primary'} onClick={() => setForm('INCOME')}>{mode === 'all' ? 'Income' : 'Add income'}</Button>}
            {mode !== 'income' && <Button icon={<TrendingDown className="h-4 w-4" />} variant={mode === 'all' ? 'secondary' : 'primary'} onClick={() => setForm('EXPENSE')}>{mode === 'all' ? 'Expense' : 'Record expense'}</Button>}
            {mode === 'all' && <Button icon={<ArrowLeftRight className="h-4 w-4" />} variant="secondary" onClick={() => setForm('TRANSFER')}>Transfer</Button>}
          </>
        )}
      />

      <Card>
        <div className="no-print space-y-3 border-b border-slate-100 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {pendingOnly ? <span className="text-sm text-slate-600">Showing all expenses awaiting approval, regardless of date.</span> : <DateRangePicker />}
            {can('reports.export') && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500">Export</span>
                {(['csv', 'xlsx', 'pdf'] as const).map((f) => <Button key={f} variant="secondary" size="sm" loading={exporting === f} disabled={!meta?.total} icon={<Download className="h-3.5 w-3.5" />} onClick={() => doExport(f)}>{f === 'xlsx' ? 'Excel' : f.toUpperCase()}</Button>)}
              </div>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <div className="relative lg:col-span-2">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <Input aria-label="Search transactions" placeholder="Search ID, description, reference, party…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            {mode === 'all' && (
              <Select aria-label="Transaction type" value={filters.type} onChange={(e) => setFilter('type', e.target.value)}>
                <option value="">All types</option>{Object.entries(TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            )}
            <Select aria-label="Category" value={filters.categoryId} onChange={(e) => setFilter('categoryId', e.target.value)}>
              <option value="">All categories</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Select aria-label="Payment method" value={filters.paymentMethod} onChange={(e) => setFilter('paymentMethod', e.target.value)}>
              <option value="">All payment methods</option>{Object.entries(METHOD_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Select aria-label="Account" value={filters.accountId} onChange={(e) => setFilter('accountId', e.target.value)}>
              <option value="">All accounts</option>{(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
            <Select aria-label="Status" value={pendingOnly ? 'PENDING_APPROVAL' : filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, approval: '' }))}>
              <option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{s === 'PENDING_APPROVAL' ? 'Pending approval' : s[0] + s.slice(1).toLowerCase()}</option>)}
            </Select>
          </div>
        </div>

        {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : rows.length === 0 ? (
          <EmptyState
            title={filtered ? 'No transactions match these filters' : `No ${mode === 'all' ? 'transactions' : mode === 'income' ? 'income' : 'expenses'} in this period`}
            message={filtered ? 'Try a different search, clear a filter or widen the date range.' : 'Records you add will appear here. Nothing is shown until real transactions exist.'}
            action={filtered ? <Button variant="secondary" onClick={() => { setSearch(''); setFilters({ type: '', status: '', paymentMethod: '', accountId: '', categoryId: '', approval: '' }); }}>Clear filters</Button>
              : canCreate ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setForm(mode === 'expense' ? 'EXPENSE' : 'INCOME')}>{mode === 'expense' ? 'Record expense' : 'Add income'}</Button> : undefined}
          />
        ) : (
          <div className={cn('table-wrap', list.isPlaceholderData && 'opacity-60')}>
            <table className="table">
              <thead className="bg-slate-50">
                <tr>
                  <SortTh field="number" label="ID" />
                  <SortTh field="date" label="Date" />
                  {mode === 'all' && <th className="th">Type</th>}
                  <th className="th">Category</th>
                  <th className="th">{mode === 'income' ? 'Customer' : mode === 'expense' ? 'Supplier' : 'Party'}</th>
                  <th className="th">Description</th>
                  <th className="th">Method</th>
                  <th className="th">Account</th>
                  <SortTh field="amount" label="Amount" className="text-right [&>button]:flex-row-reverse" />
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const s = sign(r);
                  return (
                    <tr key={r.id} className="row-click" tabIndex={0} onClick={() => setDetail(r.id)} onKeyDown={(e) => e.key === 'Enter' && setDetail(r.id)}>
                      <td className="td whitespace-nowrap font-medium text-slate-900">{r.number}{r.hasAttachment && <Paperclip className="ml-1 inline h-3 w-3 text-slate-400" aria-label="Has attachment" />}</td>
                      <td className="td whitespace-nowrap">{formatDate(r.date)}</td>
                      {mode === 'all' && <td className="td whitespace-nowrap">{typeLabel(r.type)}</td>}
                      <td className="td">{r.category ?? '—'}</td>
                      <td className="td">{r.customer ?? r.supplier ?? '—'}</td>
                      <td className="td max-w-[240px] truncate" title={r.description ?? ''}>{r.description ?? '—'}{r.reference && <span className="text-xs text-slate-400"> · {r.reference}</span>}</td>
                      <td className="td whitespace-nowrap">{methodLabel(r.paymentMethod)}</td>
                      <td className="td whitespace-nowrap">{[r.sourceAccount, r.destinationAccount].filter(Boolean).join(' → ') || '—'}</td>
                      <td className={cn('td num whitespace-nowrap font-medium', r.status !== 'POSTED' && 'text-slate-400 line-through decoration-slate-300', r.status === 'POSTED' && s > 0 && 'text-emerald-700', r.status === 'POSTED' && s < 0 && 'text-rose-700')}>
                        {s < 0 ? '−' : ''}<Money value={r.totalAmount} />
                        {r.onCredit && Number(r.outstanding) > 0 && r.status === 'POSTED' && <span className="block text-xs font-normal text-amber-700 no-underline">Unpaid <Money value={r.outstanding} /></span>}
                      </td>
                      <td className="td"><StatusBadge status={r.isReversal ? 'REVERSAL' : r.status} /></td>
                    </tr>
                  );
                })}
              </tbody>
              {meta && (
                <tfoot className="border-t-2 border-slate-200 bg-slate-50">
                  <tr>
                    <td className="td font-semibold" colSpan={mode === 'all' ? 8 : 7}>Total of {meta.total} record{meta.total === 1 ? '' : 's'} <span className="font-normal text-slate-500">(posted, excluding reversal entries{mode === 'all' ? '; gross of all types' : ''})</span></td>
                    <td className="td num font-semibold"><Money value={meta.totals.totalAmount} /></td>
                    <td className="td" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
        {meta && <Pagination page={meta.page} pageSize={meta.pageSize} total={meta.total} onPage={setPage} />}
      </Card>

      <TransactionFormModal kind={form} onClose={() => setForm(null)} />
      <TransactionDetailModal id={detail} onClose={closeDetail} onOpen={setDetail} />
    </>
  );
}
