import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, FileUp, Link2, Wand2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSubmit } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { formatDate, methodLabel, typeLabel } from '../lib/format';
import { DateRangePicker, useDateRange } from '../components/DateRangePicker';
import { Badge, Button, Card, CardHeader, cn, EmptyState, ErrorState, Loading, Money, Notice, PageHeader, Pagination, Tabs } from '../components/ui';
import { TransactionDetailModal } from '../components/TransactionDetail';

interface BookRow { id: string; date: string; direction: 'IN' | 'OUT'; amount: string; paymentMethod: string; reconciledAt: string | null; transactionId: string; number: string; type: string; description: string | null; reference: string | null; isReversal: boolean; balance: string }
interface BookMeta { page: number; pageSize: number; total: number; account: { id: string; name: string; kind: 'CASH' | 'BANK'; bankName: string | null; accountNumberMasked: string | null; isActive: boolean }; summary: { opening: string; inflow: string; outflow: string; closing: string; bookBalance: string } }
interface Recon {
  bookBalance: string; reconciledBalance: string; unreconciledIn: string; unreconciledOut: string;
  bookEntries: Array<{ id: string; date: string; direction: 'IN' | 'OUT'; amount: string; number: string; type: string; description: string | null; reference: string | null }>;
  statementLines: Array<{ id: string; date: string; description: string | null; reference: string | null; amount: string }>;
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <div><p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p><Money value={value} className={cn('text-lg font-semibold', strong ? 'text-slate-900' : 'text-slate-700')} /></div>;
}

function Reconciliation({ accountId }: { accountId: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const canManage = can('reconciliation.manage');
  const q = useQuery({ queryKey: ['reconciliation', accountId], queryFn: async () => (await api.get<Recon>(`/accounts/${accountId}/reconciliation`)).data });
  const { busy, run } = useSubmit();
  const [line, setLine] = useState<string | null>(null);
  const [entry, setEntry] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setLine(null); setEntry(null); }, [q.dataUpdatedAt]);

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast.error('The file is larger than 2 MB.');
    const csv = await file.text();
    await run(() => api.post<{ imported: number; skippedDuplicates: number }>(`/accounts/${accountId}/statement-import`, { csv }), { onDone: (r) => toast.success(`Imported ${r.data.imported} line(s)${r.data.skippedDuplicates ? `, skipped ${r.data.skippedDuplicates} duplicate(s)` : ''}`) });
  };

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const selLine = d.statementLines.find((s) => s.id === line);
  const selEntry = d.bookEntries.find((b) => b.id === entry);
  const signed = (b: { direction: string; amount: string }) => (b.direction === 'IN' ? Number(b.amount) : -Number(b.amount));
  const matches = selLine && selEntry && Math.abs(Number(selLine.amount) - signed(selEntry)) < 0.005;

  return (
    <div className="space-y-5">
      <Notice>Reconciliation compares your books with a bank statement you import as a CSV file. This application is not connected to your bank and never moves money.</Notice>
      <Card className="grid grid-cols-2 gap-4 p-5 lg:grid-cols-4">
        <Stat label="Book balance" value={d.bookBalance} strong />
        <Stat label="Reconciled balance" value={d.reconciledBalance} />
        <Stat label="Unreconciled receipts" value={d.unreconciledIn} />
        <Stat label="Unreconciled payments" value={d.unreconciledOut} />
      </Card>
      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" aria-label="Choose statement CSV" onChange={(e) => { void importFile(e.target.files?.[0]); e.target.value = ''; }} />
          <Button variant="secondary" loading={busy} icon={<FileUp className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>Import statement (CSV)</Button>
          <Button variant="secondary" disabled={busy || !d.statementLines.length} icon={<Wand2 className="h-4 w-4" />} onClick={() => run(() => api.post<{ matched: number }>(`/accounts/${accountId}/reconciliation/auto-match`), { onDone: (r) => toast[r.data.matched ? 'success' : 'info'](r.data.matched ? `Matched ${r.data.matched} item(s)` : 'No unambiguous matches found') })}>Auto-match</Button>
          <Button disabled={!matches || busy} icon={<Link2 className="h-4 w-4" />} onClick={() => run(() => api.post(`/accounts/${accountId}/reconciliation/match`, { statementLineId: line, entryId: entry }), { success: 'Matched' })}>Match selected</Button>
          {selLine && selEntry && !matches && <span className="text-xs font-medium text-rose-600">Amounts differ — only equal amounts can be matched.</span>}
          <span className="text-xs text-slate-500">CSV columns: Date, Description, Reference, and either Amount or Debit + Credit.</span>
        </div>
      )}
      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader title="Bank statement lines" description={`${d.statementLines.length} unmatched`} />
          {d.statementLines.length === 0 ? <EmptyState title="No unmatched statement lines" message="Import a statement to begin, or everything imported is already matched." /> : (
            <div className="table-wrap max-h-[460px] overflow-y-auto">
              <table className="table">
                <thead className="sticky top-0 bg-slate-50"><tr><th className="th w-8" /><th className="th">Date</th><th className="th">Description</th><th className="th num">Amount</th></tr></thead>
                <tbody>
                  {d.statementLines.map((s) => (
                    <tr key={s.id} className={cn(canManage && 'row-click', line === s.id && 'bg-brand-50')} onClick={() => canManage && setLine(line === s.id ? null : s.id)}>
                      <td className="td"><input type="radio" className="h-4 w-4" checked={line === s.id} readOnly disabled={!canManage} aria-label={`Select statement line ${s.description ?? s.date}`} /></td>
                      <td className="td whitespace-nowrap">{formatDate(s.date)}</td>
                      <td className="td">{s.description ?? '—'}{s.reference && <span className="block text-xs text-slate-500">{s.reference}</span>}</td>
                      <td className="td num"><Money value={s.amount} signed /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card>
          <CardHeader title="Book entries" description={`${d.bookEntries.length} unreconciled`} />
          {d.bookEntries.length === 0 ? <EmptyState icon={<CheckCircle2 className="h-5 w-5" />} title="Everything is reconciled" message="All recorded entries on this account have been matched." /> : (
            <div className="table-wrap max-h-[460px] overflow-y-auto">
              <table className="table">
                <thead className="sticky top-0 bg-slate-50"><tr><th className="th w-8" /><th className="th">Date</th><th className="th">Entry</th><th className="th num">Amount</th>{canManage && <th className="th" />}</tr></thead>
                <tbody>
                  {d.bookEntries.map((b) => (
                    <tr key={b.id} className={cn(canManage && 'row-click', entry === b.id && 'bg-brand-50')} onClick={() => canManage && setEntry(entry === b.id ? null : b.id)}>
                      <td className="td"><input type="radio" className="h-4 w-4" checked={entry === b.id} readOnly disabled={!canManage} aria-label={`Select book entry ${b.number}`} /></td>
                      <td className="td whitespace-nowrap">{formatDate(b.date)}</td>
                      <td className="td"><span className="font-medium text-slate-800">{b.number}</span> · {typeLabel(b.type)}<span className="block text-xs text-slate-500">{[b.description, b.reference].filter(Boolean).join(' · ') || '—'}</span></td>
                      <td className="td num"><Money value={signed(b).toFixed(2)} signed /></td>
                      {canManage && <td className="td text-right"><Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); void run(() => api.post(`/accounts/${accountId}/reconciliation/mark`, { entryId: b.id, reconciled: true }), { success: 'Marked as reconciled' }); }}>Mark reconciled</Button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

export default function AccountBook() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { range } = useDateRange();
  const { run } = useSubmit();
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<'history' | 'reconciliation'>('history');
  const [detail, setDetail] = useState<string | null>(null);
  useEffect(() => { setPage(1); }, [range.from, range.to]);
  const q = useQuery({
    queryKey: ['account-book', id, range, page],
    queryFn: () => api.get<BookRow[], BookMeta>(`/accounts/${id}/transactions`, { ...range, page, pageSize: 50 }),
    placeholderData: keepPreviousData,
  });

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;
  const { data: rows, meta } = q.data;
  const acc = meta.account;
  const back = acc.kind === 'CASH' ? '/cash' : '/bank';

  return (
    <>
      <Link to={back} className="no-print mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> {acc.kind === 'CASH' ? 'Cash Management' : 'Bank Accounts'}</Link>
      <PageHeader
        title={acc.name}
        description={<>{acc.kind === 'BANK' ? [acc.bankName, acc.accountNumberMasked].filter(Boolean).join(' · ') : 'Cash account'} {!acc.isActive && <Badge>Inactive</Badge>}</>}
        actions={tab === 'history' ? <DateRangePicker /> : undefined}
      />
      {acc.kind === 'BANK' && <Tabs value={tab} onChange={setTab} tabs={[{ value: 'history', label: 'Transaction history' }, { value: 'reconciliation', label: 'Bank reconciliation' }]} />}

      {tab === 'reconciliation' ? <Reconciliation accountId={id} /> : (
        <>
          <Card className="mb-5 grid grid-cols-2 gap-4 p-5 lg:grid-cols-5">
            <Stat label="Opening balance" value={meta.summary.opening} />
            <Stat label={acc.kind === 'CASH' ? 'Cash received' : 'Receipts'} value={meta.summary.inflow} />
            <Stat label={acc.kind === 'CASH' ? 'Cash paid' : 'Payments'} value={meta.summary.outflow} />
            <Stat label="Closing balance" value={meta.summary.closing} strong />
            <Stat label="Book balance today" value={meta.summary.bookBalance} />
          </Card>
          <Card>
            {rows.length === 0 ? <EmptyState title="No movements in this period" message="Receipts, payments, transfers and adjustments on this account will be listed here with a running balance." /> : (
              <div className={cn('table-wrap', q.isPlaceholderData && 'opacity-60')}>
                <table className="table">
                  <thead className="bg-slate-50"><tr><th className="th">Date</th><th className="th">Transaction</th><th className="th">Description</th><th className="th">Method</th><th className="th num">Money in</th><th className="th num">Money out</th><th className="th num">Balance</th>{acc.kind === 'BANK' && <th className="th">Reconciled</th>}</tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="row-click" tabIndex={0} onClick={() => setDetail(r.transactionId)} onKeyDown={(e) => e.key === 'Enter' && setDetail(r.transactionId)}>
                        <td className="td whitespace-nowrap">{formatDate(r.date)}</td>
                        <td className="td whitespace-nowrap"><span className="font-medium text-slate-900">{r.number}</span> <span className="text-xs text-slate-500">{typeLabel(r.type)}{r.isReversal ? ' (reversal)' : ''}</span></td>
                        <td className="td max-w-[280px] truncate">{r.description ?? '—'}{r.reference && <span className="text-xs text-slate-400"> · {r.reference}</span>}</td>
                        <td className="td whitespace-nowrap">{methodLabel(r.paymentMethod)}</td>
                        <td className="td num text-emerald-700">{r.direction === 'IN' ? <Money value={r.amount} /> : ''}</td>
                        <td className="td num text-rose-700">{r.direction === 'OUT' ? <Money value={r.amount} /> : ''}</td>
                        <td className="td num font-medium"><Money value={r.balance} /></td>
                        {acc.kind === 'BANK' && (
                          <td className="td" onClick={(e) => e.stopPropagation()}>
                            {r.reconciledAt
                              ? <button className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:underline disabled:no-underline" disabled={!can('reconciliation.manage')} title="Click to undo" onClick={() => run(() => api.post(`/accounts/${id}/reconciliation/unmatch`, { entryId: r.id }), { success: 'Reconciliation removed' })}><CheckCircle2 className="h-3.5 w-3.5" /> Yes</button>
                              : <span className="text-xs text-slate-400">No</span>}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination page={meta.page} pageSize={meta.pageSize} total={meta.total} onPage={setPage} />
          </Card>
        </>
      )}
      <TransactionDetailModal id={detail} onClose={() => setDetail(null)} onOpen={setDetail} />
    </>
  );
}
