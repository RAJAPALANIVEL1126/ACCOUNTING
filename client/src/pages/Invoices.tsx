import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FileText, Plus, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDebounced } from '../lib/hooks';
import { formatDate } from '../lib/format';
import { Button, Card, cn, EmptyState, ErrorState, Input, Loading, Money, PageHeader, Pagination, StatusBadge, Tabs } from '../components/ui';

export interface InvoiceRow { id: string; number: string; customerId: string; customer: string; status: string; storedStatus: string; issueDate: string; dueDate: string; currency: string; subtotal: string; discountTotal: string; taxTotal: string; total: string; amountPaid: string; outstanding: string }
interface Meta { page: number; pageSize: number; total: number; summary: { openCount: number; openOutstanding: string; overdueCount: number; overdueOutstanding: string } }
type Status = '' | 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'CANCELLED';

export default function Invoices() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [status, q]);
  const query = { status, q, page, pageSize: 25 };
  const list = useQuery({ queryKey: ['invoices', query], queryFn: () => api.get<InvoiceRow[], Meta>('/invoices', query), placeholderData: keepPreviousData });
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const newButton = can('invoices.manage') && <Link to="/invoices/new"><Button icon={<Plus className="h-4 w-4" />}>New invoice</Button></Link>;

  return (
    <>
      <PageHeader title="Invoices" description="Create, issue and track customer invoices. Revenue is recognised when an invoice is issued; payments then clear the receivable." actions={newButton} />
      {meta && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2">
          <Card className="p-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Outstanding on open invoices</p><Money value={meta.summary.openOutstanding} className="mt-1 block text-xl font-semibold text-slate-900" /><p className="mt-0.5 text-xs text-slate-500">{meta.summary.openCount} open invoice{meta.summary.openCount === 1 ? '' : 's'}</p></Card>
          <Card className="p-4"><p className="text-xs font-medium uppercase tracking-wide text-slate-500">Overdue</p><Money value={meta.summary.overdueOutstanding} className={cn('mt-1 block text-xl font-semibold', meta.summary.overdueCount ? 'text-rose-700' : 'text-slate-900')} /><p className="mt-0.5 text-xs text-slate-500">{meta.summary.overdueCount} invoice{meta.summary.overdueCount === 1 ? '' : 's'} past the due date</p></Card>
        </div>
      )}
      <Tabs<Status> value={status} onChange={setStatus} tabs={[{ value: '', label: 'All' }, { value: 'DRAFT', label: 'Draft' }, { value: 'ISSUED', label: 'Issued' }, { value: 'PARTIALLY_PAID', label: 'Partially paid' }, { value: 'PAID', label: 'Paid' }, { value: 'OVERDUE', label: 'Overdue' }, { value: 'CANCELLED', label: 'Cancelled' }]} />
      <Card>
        <div className="no-print border-b border-slate-100 p-4">
          <div className="relative w-80 max-w-full">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input aria-label="Search invoices" placeholder="Search invoice number or customer…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : rows.length === 0 ? (
          <EmptyState icon={<FileText className="h-5 w-5" />} title={q || status ? 'No invoices match' : 'No invoices yet'} message={q || status ? 'Try another status tab or search term.' : 'Create an invoice to bill a customer and track what they owe.'} action={!q && !status ? newButton || undefined : undefined} />
        ) : (
          <div className={cn('table-wrap', list.isPlaceholderData && 'opacity-60')}>
            <table className="table">
              <thead className="bg-slate-50"><tr><th className="th">Invoice</th><th className="th">Customer</th><th className="th">Invoice date</th><th className="th">Due date</th><th className="th num">Total</th><th className="th num">Paid</th><th className="th num">Outstanding</th><th className="th">Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="row-click" tabIndex={0} onClick={() => navigate(`/invoices/${r.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/invoices/${r.id}`)}>
                    <td className="td whitespace-nowrap font-medium text-slate-900">{r.number}</td>
                    <td className="td">{r.customer}</td>
                    <td className="td whitespace-nowrap">{formatDate(r.issueDate)}</td>
                    <td className={cn('td whitespace-nowrap', r.status === 'OVERDUE' && 'font-medium text-rose-700')}>{formatDate(r.dueDate)}</td>
                    <td className="td num font-medium"><Money value={r.total} /></td>
                    <td className="td num"><Money value={r.amountPaid} /></td>
                    <td className="td num"><Money value={r.outstanding} /></td>
                    <td className="td"><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {meta && <Pagination page={meta.page} pageSize={meta.pageSize} total={meta.total} onPage={setPage} />}
      </Card>
    </>
  );
}
