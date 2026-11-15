import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ScrollText, Search } from 'lucide-react';
import { api } from '../lib/api';
import { useDebounced } from '../lib/hooks';
import { formatDateTime } from '../lib/format';
import { DateRangePicker, useDateRange } from '../components/DateRangePicker';
import { Card, cn, EmptyState, ErrorState, Input, Loading, Modal, Notice, PageHeader, Pagination, Select } from '../components/ui';

interface Log { id: string; userId: string | null; userName: string | null; action: string; entityType: string; entityId: string | null; summary: string; metadata: unknown; ip: string | null; userAgent: string | null; createdAt: string }
interface Meta { page: number; pageSize: number; total: number; entityTypes: string[] }

const ACTION_GROUPS: Array<[string, string]> = [
  ['', 'All actions'], ['transaction', 'Transactions'], ['expense', 'Expense approvals'], ['adjustment', 'Adjustments'], ['invoice', 'Invoices'], ['payment', 'Payments'],
  ['user', 'User accounts'], ['auth', 'Sign-in and passwords'], ['company', 'Company details'], ['settings', 'Settings'], ['account', 'Accounts'], ['reconciliation', 'Reconciliation'], ['export', 'Exports'],
];

export default function AuditLogs() {
  const { range } = useDateRange();
  const [filters, setFilters] = useState({ action: '', entityType: '', userId: '' });
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Log | null>(null);
  useEffect(() => { setPage(1); }, [filters, q, range.from, range.to]);
  const users = useQuery({ queryKey: ['users'], queryFn: async () => (await api.get<Array<{ id: string; fullName: string }>>('/users')).data });
  const query = { ...range, ...filters, q, page, pageSize: 50 };
  const list = useQuery({ queryKey: ['audit-logs', query], queryFn: () => api.get<Log[], Meta>('/audit-logs', query), placeholderData: keepPreviousData });
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;

  return (
    <>
      <PageHeader title="Audit Logs" description="A permanent, read-only record of important actions. Entries cannot be edited or deleted by anyone." />
      <Card>
        <div className="no-print space-y-3 border-b border-slate-100 p-4">
          <DateRangePicker />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <Input aria-label="Search audit log" placeholder="Search summaries…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select aria-label="Action" value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })}>{ACTION_GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
            <Select aria-label="Record type" value={filters.entityType} onChange={(e) => setFilters({ ...filters, entityType: e.target.value })}><option value="">All record types</option>{(meta?.entityTypes ?? []).map((t) => <option key={t} value={t}>{t}</option>)}</Select>
            <Select aria-label="User" value={filters.userId} onChange={(e) => setFilters({ ...filters, userId: e.target.value })}><option value="">All users</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>
          </div>
        </div>
        {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : rows.length === 0 ? (
          <EmptyState icon={<ScrollText className="h-5 w-5" />} title="No audit entries found" message="No recorded actions match the selected period and filters." />
        ) : (
          <div className={cn('table-wrap', list.isPlaceholderData && 'opacity-60')}>
            <table className="table">
              <thead className="bg-slate-50"><tr><th className="th">When</th><th className="th">User</th><th className="th">Action</th><th className="th">Record</th><th className="th">Change summary</th></tr></thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id} className="row-click" tabIndex={0} onClick={() => setOpen(l)} onKeyDown={(e) => e.key === 'Enter' && setOpen(l)}>
                    <td className="td whitespace-nowrap">{formatDateTime(l.createdAt)}</td>
                    <td className="td whitespace-nowrap">{l.userName ?? 'System'}</td>
                    <td className="td whitespace-nowrap font-mono text-xs">{l.action}</td>
                    <td className="td whitespace-nowrap">{l.entityType}</td>
                    <td className="td max-w-[520px] truncate" title={l.summary}>{l.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {meta && <Pagination page={meta.page} pageSize={meta.pageSize} total={meta.total} onPage={setPage} />}
      </Card>

      <Modal open={Boolean(open)} onClose={() => setOpen(null)} title="Audit entry" size="lg">
        {open && (
          <div className="space-y-4 text-sm">
            <p className="text-slate-800">{open.summary}</p>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {[['When', formatDateTime(open.createdAt)], ['User', open.userName ?? 'System'], ['Action', open.action], ['Record type', open.entityType], ['Record ID', open.entityId ?? '—'], ['IP address', open.ip ?? '—']].map(([k, v]) => (
                <div key={k}><dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt><dd className="mt-0.5 break-all text-slate-800">{v}</dd></div>
              ))}
            </dl>
            {open.userAgent && <p className="break-words text-xs text-slate-500">Browser: {open.userAgent}</p>}
            {open.metadata != null && <div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Details</p><pre className="max-h-64 overflow-auto rounded-md bg-slate-50 p-3 text-xs text-slate-700">{JSON.stringify(open.metadata, null, 2)}</pre></div>}
            <Notice>Passwords, tokens and other secrets are never written to the audit log.</Notice>
          </div>
        )}
      </Modal>
    </>
  );
}
