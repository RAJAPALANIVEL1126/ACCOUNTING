import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CreditCard, Plus, Search, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDebounced, useSubmit } from '../lib/hooks';
import { formatDate, METHOD_LABELS, methodLabel } from '../lib/format';
import { DateRangePicker, useDateRange } from '../components/DateRangePicker';
import { Button, Card, cn, ConfirmDialog, EmptyState, ErrorState, Input, Loading, Money, Notice, PageHeader, Pagination, Select, StatusBadge } from '../components/ui';
import { RecordOnlinePaymentDialog, RefundDialog } from '../components/PaymentDialogs';
import { TransactionDetailModal } from '../components/TransactionDetail';

interface PaymentRow {
  id: string; number: string; direction: string; status: string; method: string; gateway: string | null; gatewayPaymentId: string | null; reference: string | null; party: string | null;
  invoice: string | null; invoiceId: string | null; date: string; amount: string; fee: string; net: string; refundedAmount: string; refundStatus: string; reconStatus: string; transactionId: string | null; notes: string | null;
}
interface Meta {
  page: number; pageSize: number; total: number;
  summary: { successAmount: string; successCount: number; fees: string; refunded: string; pendingAmount: string; pendingCount: number };
  gateway: { configured: boolean; mode: string; provider: string | null; message: string };
}
const ONLINE = ['UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'PAYMENT_GATEWAY', 'BANK_TRANSFER'];

export default function Payments() {
  const { can } = useAuth();
  const canManage = can('payments.manage');
  const { range } = useDateRange();
  const [params] = useSearchParams();
  const [filters, setFilters] = useState({ status: params.get('status') ?? '', method: '', recon: '' });
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  const [recording, setRecording] = useState(false);
  const [refund, setRefund] = useState<PaymentRow | null>(null);
  const [confirm, setConfirm] = useState<{ row: PaymentRow; status: 'SUCCESS' | 'FAILED' } | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const { busy, run } = useSubmit();
  useEffect(() => { setPage(1); }, [filters, q, range.from, range.to]);

  // Pending payments are shown regardless of date so none is forgotten.
  const query = { ...(filters.status === 'PENDING' ? {} : range), ...filters, q, online: 1, page, pageSize: 25 };
  const list = useQuery({ queryKey: ['payments', query], queryFn: () => api.get<PaymentRow[], Meta>('/payments', query), placeholderData: keepPreviousData });
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const gatewayManaged = (p: PaymentRow) => p.gateway === 'razorpay' && Boolean(meta?.gateway.configured);

  return (
    <>
      <PageHeader title="Online Payments" description="UPI, card, net banking, gateway and bank-transfer payments, with fees, refunds and reconciliation."
        actions={canManage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setRecording(true)}>Record online payment</Button>} />

      {meta && (
        <div className="mb-5">
          <Notice tone={meta.gateway.configured ? 'green' : 'amber'} title={meta.gateway.configured ? 'Payment gateway connected (Razorpay)' : 'Transaction-recording mode'}>
            {meta.gateway.configured
              ? 'Online collection is available from issued invoices. A payment is marked successful only after the gateway confirms it to the server with a signed notification.'
              : 'No payment gateway is configured, so this application does not collect money. Record payments here after they reach your bank or payment provider. An administrator can enable Razorpay under Settings.'}
          </Notice>
        </div>
      )}

      {meta && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            ['Successful payments', meta.summary.successAmount, `${meta.summary.successCount} payment${meta.summary.successCount === 1 ? '' : 's'}`],
            ['Processing fees', meta.summary.fees, 'Charged by providers'],
            ['Refunded', meta.summary.refunded, 'Returned to customers'],
            ['Pending', meta.summary.pendingAmount, `${meta.summary.pendingCount} awaiting confirmation`],
          ].map(([label, value, hint]) => (
            <Card key={label} className="p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
              <Money value={value} className="mt-1 block text-xl font-semibold text-slate-900" />
              <p className="mt-0.5 text-xs text-slate-500">{hint}</p>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <div className="no-print space-y-3 border-b border-slate-100 p-4">
          {filters.status === 'PENDING' ? <p className="text-sm text-slate-600">Showing all pending payments, regardless of date.</p> : <DateRangePicker />}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <div className="relative lg:col-span-2">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <Input aria-label="Search payments" placeholder="Search reference ID, customer, invoice…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Select aria-label="Payment status" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">All statuses</option>{['SUCCESS', 'PENDING', 'FAILED', 'CANCELLED', 'REVERSED'].map((s) => <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()}</option>)}
            </Select>
            <Select aria-label="Payment method" value={filters.method} onChange={(e) => setFilters({ ...filters, method: e.target.value })}>
              <option value="">All online methods</option>{ONLINE.map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
            </Select>
            <Select aria-label="Reconciliation status" value={filters.recon} onChange={(e) => setFilters({ ...filters, recon: e.target.value })}>
              <option value="">Any reconciliation</option><option value="UNRECONCILED">Unreconciled</option><option value="RECONCILED">Reconciled</option>
            </Select>
          </div>
        </div>

        {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : rows.length === 0 ? (
          <EmptyState icon={<CreditCard className="h-5 w-5" />} title="No online payments found" message="Payments received by UPI, card, net banking, gateway or bank transfer in this period will be listed here."
            action={canManage ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setRecording(true)}>Record online payment</Button> : undefined} />
        ) : (
          <div className={cn('table-wrap', list.isPlaceholderData && 'opacity-60')}>
            <table className="table">
              <thead className="bg-slate-50"><tr><th className="th">Payment</th><th className="th">Date</th><th className="th">Customer / Supplier</th><th className="th">Invoice</th><th className="th">Method / Gateway</th><th className="th">Reference ID</th><th className="th num">Amount</th><th className="th num">Fee</th><th className="th">Status</th><th className="th">Refund</th><th className="th">Reconciliation</th>{canManage && <th className="th" />}</tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="td whitespace-nowrap font-medium text-slate-900">{p.transactionId ? <button className="hover:underline" onClick={() => setDetail(p.transactionId)}>{p.number}</button> : p.number}</td>
                    <td className="td whitespace-nowrap">{formatDate(p.date)}</td>
                    <td className="td">{p.party ?? '—'}</td>
                    <td className="td whitespace-nowrap">{p.invoiceId ? <Link className="text-brand-600 hover:underline" to={`/invoices/${p.invoiceId}`}>{p.invoice}</Link> : '—'}</td>
                    <td className="td whitespace-nowrap">{methodLabel(p.method)}{p.gateway && <span className="block text-xs capitalize text-slate-500">{p.gateway}</span>}</td>
                    <td className="td max-w-[160px] truncate font-mono text-xs" title={p.gatewayPaymentId ?? p.reference ?? ''}>{p.gatewayPaymentId ?? p.reference ?? '—'}</td>
                    <td className="td num font-medium"><Money value={p.amount} /></td>
                    <td className="td num">{Number(p.fee) ? <Money value={p.fee} /> : '—'}</td>
                    <td className="td"><StatusBadge status={p.status} /></td>
                    <td className="td">{p.refundStatus === 'NONE' ? <span className="text-xs text-slate-400">None</span> : <><StatusBadge status={p.refundStatus} /><Money value={p.refundedAmount} className="block text-xs text-slate-500" /></>}</td>
                    <td className="td">
                      {p.status === 'SUCCESS' && canManage
                        ? <button className="rounded hover:opacity-80" title="Click to toggle" disabled={busy} onClick={() => run(() => api.post(`/payments/${p.id}/reconcile`, { reconciled: p.reconStatus !== 'RECONCILED' }), { success: p.reconStatus === 'RECONCILED' ? 'Marked unreconciled' : 'Marked reconciled' })}><StatusBadge status={p.reconStatus} /></button>
                        : p.status === 'SUCCESS' ? <StatusBadge status={p.reconStatus} /> : <span className="text-xs text-slate-400">—</span>}
                    </td>
                    {canManage && (
                      <td className="td whitespace-nowrap text-right">
                        {p.status === 'PENDING' && (gatewayManaged(p)
                          ? <Button variant="secondary" size="sm" disabled={busy} icon={<ShieldCheck className="h-3.5 w-3.5" />} onClick={() => run(() => api.post(`/payments/${p.id}/verify`), { success: 'Checked with the gateway' })}>Verify with gateway</Button>
                          : <><Button variant="ghost" size="sm" onClick={() => setConfirm({ row: p, status: 'FAILED' })}>Mark failed</Button><Button variant="secondary" size="sm" onClick={() => setConfirm({ row: p, status: 'SUCCESS' })}>Confirm received</Button></>)}
                        {p.status === 'SUCCESS' && p.direction === 'INBOUND' && p.refundStatus !== 'FULL' && <Button variant="ghost" size="sm" onClick={() => setRefund(p)}>Refund</Button>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {meta && <Pagination page={meta.page} pageSize={meta.pageSize} total={meta.total} onPage={setPage} />}
      </Card>

      <RecordOnlinePaymentDialog open={recording} onClose={() => setRecording(false)} />
      <RefundDialog open={Boolean(refund)} onClose={() => setRefund(null)} payment={refund} />
      <TransactionDetailModal id={detail} onClose={() => setDetail(null)} onOpen={setDetail} />
      <ConfirmDialog
        open={Boolean(confirm)} onClose={() => setConfirm(null)} danger={confirm?.status === 'FAILED'}
        title={confirm?.status === 'SUCCESS' ? `Confirm payment ${confirm.row.number} was received?` : `Mark payment ${confirm?.row.number ?? ''} as failed?`}
        confirmLabel={confirm?.status === 'SUCCESS' ? 'Confirm and post' : 'Mark failed'}
        message={confirm?.status === 'SUCCESS'
          ? <>Only confirm after checking your bank or provider statement. <Money value={confirm.row.amount} /> will be posted to the books{confirm.row.invoice ? ` and applied to invoice ${confirm.row.invoice}` : ''}.</>
          : 'The payment will be closed without affecting the books.'}
        onConfirm={async () => { const r = await run(() => api.post(`/payments/${confirm!.row.id}/status`, { status: confirm!.status }), { success: confirm!.status === 'SUCCESS' ? 'Payment confirmed and posted' : 'Payment marked failed' }); if (r === undefined) throw new Error('The payment could not be updated.'); }}
      />
    </>
  );
}
