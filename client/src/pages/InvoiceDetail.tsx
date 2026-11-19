import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ban, CreditCard, Download, HandCoins, Pencil, Printer, Send } from 'lucide-react';
import { api, download, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAccounts, useSettings, useSubmit } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { formatDate, methodLabel } from '../lib/format';
import { Button, Card, CardHeader, ConfirmDialog, ErrorState, Field, Loading, Modal, Money, Notice, PageHeader, Select, StatusBadge } from '../components/ui';
import { SettleDialog } from '../components/PaymentDialogs';
import { TransactionDetailModal } from '../components/TransactionDetail';
import type { InvoiceRow } from './Invoices';

interface Detail extends InvoiceRow {
  notes: string | null; terms: string | null; cancelReason: string | null; createdBy: string | null; createdAt: string;
  customerDetails: { name: string; businessName: string | null; email: string | null; phone: string | null; address: string | null; gstin: string | null };
  items: Array<{ id: string; description: string; quantity: string; unitPrice: string; discount: string; taxRate: string; category: string; lineNet: string; lineTax: string; lineTotal: string }>;
  payments: Array<{ id: string; number: string; date: string; method: string; amount: string; fee: string; status: string; refundedAmount: string; reference: string | null; transactionId: string | null }>;
  gateway: { configured: boolean; keyId: string | null };
}
interface Order { paymentId: string; orderId: string; amount: number; currency: string; keyId: string; invoiceNumber: string; customer: { name: string; email: string | null; phone: string | null } }
type RazorpayCtor = new (options: Record<string, unknown>) => { open: () => void; on: (event: string, cb: () => void) => void };

function loadCheckout(): Promise<RazorpayCtor> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as { Razorpay?: RazorpayCtor };
    if (w.Razorpay) return resolve(w.Razorpay);
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => (w.Razorpay ? resolve(w.Razorpay) : reject(new Error('Payment checkout failed to load')));
    s.onerror = () => reject(new Error('Payment checkout could not be loaded'));
    document.head.appendChild(s);
  });
}

export default function InvoiceDetail() {
  const { id = '' } = useParams();
  const { can, company } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['invoice', id], queryFn: async () => (await api.get<Detail>(`/invoices/${id}`)).data });
  const co = useQuery({ queryKey: ['company'], queryFn: async () => (await api.get<Record<string, string | null>>('/company')).data });
  const settings = useSettings();
  const accounts = useAccounts(can('payments.manage'));
  const { busy, run } = useSubmit();
  const [paying, setPaying] = useState(false);
  const [confirm, setConfirm] = useState<'issue' | 'cancel' | null>(null);
  const [collect, setCollect] = useState(false);
  const [collectAccount, setCollectAccount] = useState('');
  const [detail, setDetail] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;
  const inv = q.data;
  const c = co.data;
  const taxLabel = settings.data?.settings.taxLabel ?? 'Tax';
  const open = ['ISSUED', 'PARTIALLY_PAID'].includes(inv.storedStatus);
  const manage = can('invoices.manage');
  const hasTax = Number(inv.taxTotal) > 0;
  const bankAccounts = (accounts.data ?? []).filter((a) => a.kind === 'BANK' && a.isActive);

  const pdf = async () => { setDownloading(true); try { await download(`/invoices/${id}/pdf`, undefined, `${inv.number}.pdf`); } catch (e) { toast.error(errorMessage(e)); } finally { setDownloading(false); } };
  const act = async (path: string, body: unknown, success: string) => { const r = await run(() => api.post(`/invoices/${id}/${path}`, body), { success }); if (r === undefined) throw new Error('The action could not be completed'); };

  const startCollection = async () => {
    const order = await run((key) => api.post<Order>(`/invoices/${id}/payment-order`, { accountId: collectAccount }, key));
    if (!order) return;
    setCollect(false);
    try {
      const Razorpay = await loadCheckout();
      const o = order.data;
      // The browser result is never trusted: after checkout closes we ask the server, which asks the gateway.
      const verify = async () => { try { await api.post(`/payments/${o.paymentId}/verify`); } catch { /* the signed webhook will still settle it */ } await qc.invalidateQueries(); };
      const rz = new Razorpay({ key: o.keyId, order_id: o.orderId, amount: o.amount, currency: o.currency, name: company?.name, description: `Invoice ${o.invoiceNumber}`, prefill: { name: o.customer.name, email: o.customer.email ?? undefined, contact: o.customer.phone ?? undefined }, handler: () => { toast.info('Payment submitted. Confirming with the gateway…'); void verify(); }, modal: { ondismiss: () => { void verify(); } } });
      rz.open();
    } catch (e) { toast.error(errorMessage(e)); }
  };

  return (
    <>
      <Link to="/invoices" className="no-print mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Invoices</Link>
      <PageHeader
        title={`Invoice ${inv.number}`}
        description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={inv.status} /> {inv.customer} · created by {inv.createdBy ?? '—'}</span>}
        actions={
          <>
            <Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>Print</Button>
            <Button variant="secondary" loading={downloading} icon={<Download className="h-4 w-4" />} onClick={pdf}>PDF</Button>
            {inv.storedStatus === 'DRAFT' && manage && <Link to={`/invoices/${id}/edit`}><Button variant="secondary" icon={<Pencil className="h-4 w-4" />}>Edit</Button></Link>}
            {inv.storedStatus !== 'CANCELLED' && inv.storedStatus !== 'PAID' && manage && <Button variant="secondary" icon={<Ban className="h-4 w-4" />} onClick={() => setConfirm('cancel')}>Cancel invoice</Button>}
            {inv.storedStatus === 'DRAFT' && manage && <Button icon={<Send className="h-4 w-4" />} onClick={() => setConfirm('issue')}>Issue invoice</Button>}
            {open && can('payments.manage') && inv.gateway.configured && <Button variant="secondary" icon={<CreditCard className="h-4 w-4" />} onClick={() => { setCollectAccount(''); setCollect(true); }}>Collect online</Button>}
            {open && can('payments.manage') && <Button icon={<HandCoins className="h-4 w-4" />} onClick={() => setPaying(true)}>Record payment</Button>}
          </>
        }
      />
      {inv.storedStatus === 'DRAFT' && <div className="no-print mb-4"><Notice tone="amber">This is a draft. It does not affect revenue, receivables or reports until it is issued.</Notice></div>}
      {inv.storedStatus === 'CANCELLED' && <div className="no-print mb-4"><Notice tone="red">Cancelled{inv.cancelReason ? `: ${inv.cancelReason}` : ''}. Its revenue and receivable have been reversed.</Notice></div>}

      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <Card className="print-area p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-6">
            <div className="min-w-0">
              {company?.logoAttachmentId && <img src={`/api/company/logo?v=${company.logoAttachmentId}`} alt="" className="mb-3 max-h-16 max-w-[180px] object-contain" />}
              <p className="text-lg font-semibold text-slate-900">{c?.name ?? company?.name}</p>
              <div className="mt-1 space-y-0.5 text-sm text-slate-600">
                {c?.address && <p className="whitespace-pre-line">{c.address}</p>}
                {(c?.city || c?.state || c?.postalCode) && <p>{[c?.city, c?.state, c?.postalCode].filter(Boolean).join(', ')}</p>}
                {c?.gstin && <p>GSTIN: {c.gstin}</p>}
                {c?.pan && <p>PAN: {c.pan}</p>}
                {(c?.email || c?.phone) && <p>{[c?.email, c?.phone].filter(Boolean).join(' · ')}</p>}
              </div>
            </div>
            <div className="text-right">
              <p className="text-2xl font-semibold tracking-tight text-navy-800">{hasTax ? 'TAX INVOICE' : 'INVOICE'}</p>
              <dl className="mt-2 space-y-0.5 text-sm">
                <div><dt className="inline text-slate-500">Invoice no. </dt><dd className="inline font-medium text-slate-900">{inv.number}</dd></div>
                <div><dt className="inline text-slate-500">Invoice date </dt><dd className="inline text-slate-900">{formatDate(inv.issueDate)}</dd></div>
                <div><dt className="inline text-slate-500">Due date </dt><dd className="inline text-slate-900">{formatDate(inv.dueDate)}</dd></div>
              </dl>
            </div>
          </div>

          <div className="mt-7">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Bill to</p>
            <p className="mt-1 font-semibold text-slate-900">{inv.customerDetails.businessName || inv.customerDetails.name}</p>
            <div className="space-y-0.5 text-sm text-slate-600">
              {inv.customerDetails.businessName && <p>{inv.customerDetails.name}</p>}
              {inv.customerDetails.address && <p className="whitespace-pre-line">{inv.customerDetails.address}</p>}
              {inv.customerDetails.gstin && <p>GSTIN: {inv.customerDetails.gstin}</p>}
              {(inv.customerDetails.email || inv.customerDetails.phone) && <p>{[inv.customerDetails.email, inv.customerDetails.phone].filter(Boolean).join(' · ')}</p>}
            </div>
          </div>

          <div className="table-wrap mt-6">
            <table className="table">
              <thead><tr className="border-b-2 border-slate-300"><th className="th">Description</th><th className="th num">Qty</th><th className="th num">Unit price</th><th className="th num">Discount</th>{hasTax && <th className="th num">{taxLabel}</th>}<th className="th num">Amount</th></tr></thead>
              <tbody>
                {inv.items.map((it) => (
                  <tr key={it.id}>
                    <td className="td text-slate-900">{it.description}</td>
                    <td className="td num">{Number(it.quantity)}</td>
                    <td className="td num"><Money value={it.unitPrice} /></td>
                    <td className="td num">{Number(it.discount) ? <Money value={it.discount} /> : '—'}</td>
                    {hasTax && <td className="td num">{Number(it.taxRate)}%</td>}
                    <td className="td num font-medium"><Money value={it.lineNet} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-5 flex justify-end">
            <dl className="w-full max-w-xs space-y-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-slate-500">Subtotal</dt><dd><Money value={inv.subtotal} /></dd></div>
              {Number(inv.discountTotal) > 0 && <div className="flex justify-between"><dt className="text-slate-500">Discount</dt><dd>−<Money value={inv.discountTotal} /></dd></div>}
              {hasTax && <div className="flex justify-between"><dt className="text-slate-500">{taxLabel}</dt><dd><Money value={inv.taxTotal} /></dd></div>}
              <div className="flex justify-between border-t border-slate-300 pt-2 text-base font-semibold text-slate-900"><dt>Total ({inv.currency})</dt><dd><Money value={inv.total} /></dd></div>
              <div className="flex justify-between"><dt className="text-slate-500">Amount paid</dt><dd><Money value={inv.amountPaid} /></dd></div>
              <div className="flex justify-between font-semibold text-slate-900"><dt>Balance due</dt><dd><Money value={inv.outstanding} /></dd></div>
            </dl>
          </div>
          {inv.notes && <div className="mt-6"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notes</p><p className="mt-1 whitespace-pre-line text-sm text-slate-700">{inv.notes}</p></div>}
          {inv.terms && <div className="mt-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Terms</p><p className="mt-1 whitespace-pre-line text-sm text-slate-700">{inv.terms}</p></div>}
        </Card>

        <div className="no-print space-y-5">
          <Card className="p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Outstanding balance</p>
            <Money value={inv.outstanding} className="mt-1 block text-2xl font-semibold text-slate-900" />
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label="Paid share" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(inv.total) ? Math.round((Number(inv.amountPaid) / Number(inv.total)) * 100) : 0}>
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Number(inv.total) ? Math.min(100, (Number(inv.amountPaid) / Number(inv.total)) * 100) : 0}%` }} />
            </div>
            <p className="mt-2 text-xs text-slate-500"><Money value={inv.amountPaid} /> paid of <Money value={inv.total} /></p>
          </Card>
          <Card>
            <CardHeader title="Payments" description="Receipts and refunds recorded against this invoice" />
            {inv.payments.length === 0 ? <p className="px-5 py-6 text-center text-sm text-slate-500">No payments recorded.</p> : (
              <ul className="divide-y divide-slate-100">
                {inv.payments.map((p) => (
                  <li key={p.id} className="px-5 py-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-900">{p.transactionId ? <button className="hover:underline" onClick={() => setDetail(p.transactionId)}>{p.number}</button> : p.number}</span>
                      <Money value={p.amount} className="font-medium" />
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2 text-xs text-slate-500">
                      <span>{formatDate(p.date)} · {methodLabel(p.method)}{p.reference ? ` · ${p.reference}` : ''}</span>
                      <StatusBadge status={p.status} />
                    </div>
                    {Number(p.refundedAmount) > 0 && <p className="mt-0.5 text-xs text-violet-700">Refunded <Money value={p.refundedAmount} /></p>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <SettleDialog open={paying} onClose={() => setPaying(false)} target={{ kind: 'invoice', id, number: inv.number, outstanding: inv.outstanding, party: inv.customer }} />
      <TransactionDetailModal id={detail} onClose={() => setDetail(null)} onOpen={setDetail} />
      <ConfirmDialog open={confirm === 'issue'} onClose={() => setConfirm(null)} title={`Issue invoice ${inv.number}?`} confirmLabel="Issue invoice"
        message={<>Issuing records revenue and a receivable of <Money value={inv.total} /> dated {formatDate(inv.issueDate)}. An issued invoice cannot be edited — only cancelled.</>} onConfirm={() => act('issue', {}, 'Invoice issued')} />
      <ConfirmDialog open={confirm === 'cancel'} onClose={() => setConfirm(null)} danger title={`Cancel invoice ${inv.number}?`} confirmLabel="Cancel invoice" reasonLabel="Reason for cancellation"
        message={inv.storedStatus === 'DRAFT' ? 'The draft will be marked cancelled.' : 'The invoice’s revenue and receivable will be reversed with a dated entry. Invoices with payments must have those payments refunded or reversed first.'} onConfirm={(reason) => act('cancel', { reason }, 'Invoice cancelled')} />
      <Modal open={collect} onClose={() => setCollect(false)} title="Collect online payment" size="sm" footer={<><Button variant="secondary" onClick={() => setCollect(false)}>Cancel</Button><Button loading={busy} disabled={!collectAccount} onClick={startCollection}>Open secure checkout</Button></>}>
        <div className="space-y-3 text-sm text-slate-600">
          <p>Collect the outstanding <Money value={inv.outstanding} className="font-semibold text-slate-900" /> through Razorpay. The invoice is marked paid only after the gateway confirms the payment to the server.</p>
          <Field label="Settlement bank account" required><Select value={collectAccount} onChange={(e) => setCollectAccount(e.target.value)}><option value="">Select a bank account</option>{bankAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        </div>
      </Modal>
    </>
  );
}
