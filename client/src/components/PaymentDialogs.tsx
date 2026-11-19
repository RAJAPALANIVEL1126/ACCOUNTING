import { useEffect } from 'react';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAccounts, useCategories, useForm, useParties, useSubmit } from '../lib/hooks';
import { todayIso } from '../lib/dates';
import { formatMoney, fromPaise, METHOD_LABELS, toPaise } from '../lib/format';
import { Button, Field, Input, Modal, Notice, Select, Textarea } from './ui';
import { accountLabel, accountsFor } from './TransactionForms';

const ALL_METHODS = ['CASH', 'BANK_TRANSFER', 'UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'PAYMENT_GATEWAY', 'CHEQUE'];
const ONLINE_METHODS = ['UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'PAYMENT_GATEWAY', 'BANK_TRANSFER'];

function useAccountSync(method: string, accountId: string, setAccount: (id: string) => void) {
  const accounts = useAccounts();
  const options = accountsFor(accounts.data, method);
  // Clear an account that no longer fits the payment method. Nothing is chosen automatically.
  useEffect(() => {
    if (accounts.data && accountId && !options.some((a) => a.id === accountId)) setAccount('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, accounts.data, accountId]);
  return options;
}

/** Receive money against an invoice, or pay a supplier bill. */
export function SettleDialog({ open, onClose, target }: { open: boolean; onClose: () => void; target: { kind: 'invoice' | 'bill'; id: string; number: string; outstanding: string; party: string } | null }) {
  const { currency } = useAuth();
  const { busy, run } = useSubmit();
  const blank = { date: '', amount: '', paymentMethod: '', accountId: '', reference: '', gatewayPaymentId: '', fee: '' };
  const f = useForm(blank);
  useEffect(() => { if (open && target) f.reset(blank); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, target?.id]);
  const options = useAccountSync(f.values.paymentMethod, f.values.accountId, (id) => f.set('accountId', id));
  if (!target) return null;
  const invoice = target.kind === 'invoice';
  const online = ONLINE_METHODS.includes(f.values.paymentMethod);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { gatewayPaymentId, fee, ...rest } = f.values;
    void run((key) => api.post(invoice ? `/invoices/${target.id}/payments` : `/expenses/${target.id}/payments`, invoice ? { ...rest, gatewayPaymentId, fee } : rest, key), {
      success: invoice ? 'Payment recorded' : 'Supplier payment recorded', setErrors: f.setErrors, onDone: onClose,
    });
  };
  return (
    <Modal open={open} onClose={onClose} title={invoice ? `Record payment — ${target.number}` : `Pay bill — ${target.number}`} description={`${target.party} · outstanding ${formatMoney(target.outstanding, currency)}`}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Payment date" required error={f.errors.date}><Input type="date" max={todayIso()} {...f.bind('date')} /></Field>
          <Field label={`Amount (${currency})`} required error={f.errors.amount} hint={`Up to ${formatMoney(target.outstanding, currency)}; partial payments are allowed`}><Input inputMode="decimal" placeholder="0.00" {...f.bind('amount')} /></Field>
          <Field label="Payment method" required error={f.errors.paymentMethod}><Select {...f.bind('paymentMethod')}><option value="">Select a payment method</option>{ALL_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}</Select></Field>
          <Field label={invoice ? 'Deposit to account' : 'Paid from account'} required error={f.errors.accountId}>
            <Select {...f.bind('accountId')}><option value="">Select an account</option>{options.map((a) => <option key={a.id} value={a.id}>{accountLabel(a, currency)}</option>)}</Select>
          </Field>
          {invoice && online && (
            <>
              <Field label="Payment reference ID" error={f.errors.gatewayPaymentId} hint="UTR / UPI / gateway ID. Prevents duplicates."><Input {...f.bind('gatewayPaymentId')} maxLength={100} /></Field>
              <Field label={`Processing fee (${currency})`} error={f.errors.fee} hint="Deducted by the gateway, if any"><Input inputMode="decimal" placeholder="0.00" {...f.bind('fee')} /></Field>
            </>
          )}
          <Field label="Reference / note" error={f.errors.reference} className="sm:col-span-2"><Input {...f.bind('reference')} maxLength={100} /></Field>
        </div>
        <div className="flex justify-end gap-2 pt-1"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>{invoice ? 'Record payment' : 'Record payment to supplier'}</Button></div>
      </form>
    </Modal>
  );
}

interface OpenInvoice { id: string; number: string; customer: string; outstanding: string }

/** Online Payments module: record a payment received through UPI, card, net banking, a gateway or bank transfer. */
export function RecordOnlinePaymentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { currency } = useAuth();
  const { busy, run } = useSubmit();
  const blank = { linkTo: 'invoice', invoiceId: '', customerId: '', categoryId: '', status: '', method: '', gateway: '', gatewayPaymentId: '', accountId: '', date: '', amount: '', fee: '', notes: '' };
  const f = useForm(blank);
  useEffect(() => { if (open) f.reset(blank); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);
  const v = f.values;
  const invoices = useQuery({ queryKey: ['invoices', 'open'], queryFn: async () => (await api.get<OpenInvoice[]>('/invoices', { open: 1, pageSize: 200 })).data, enabled: open });
  const customers = useParties('customers', open);
  const categories = useCategories(open);
  const options = useAccountSync(v.method, v.accountId, (id) => f.set('accountId', id));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run((key) => api.post('/payments', {
      direction: 'INBOUND', status: v.status, method: v.method, gateway: v.gateway, gatewayPaymentId: v.gatewayPaymentId, accountId: v.accountId, date: v.date, amount: v.amount, fee: v.fee, notes: v.notes,
      invoiceId: v.linkTo === 'invoice' ? v.invoiceId : '', customerId: v.linkTo === 'income' ? v.customerId : v.linkTo === 'customer' ? v.customerId : '', categoryId: v.linkTo === 'income' ? v.categoryId : '',
    }, key), { success: v.status === 'PENDING' ? 'Pending payment recorded' : 'Payment recorded and posted', setErrors: f.setErrors, onDone: onClose });
  };
  const net = toPaise(v.amount) - toPaise(v.fee);

  return (
    <Modal open={open} onClose={onClose} title="Record online payment" size="lg" description="Records a payment that has already taken place. It does not collect money.">
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="This payment is for" required>
            <Select {...f.bind('linkTo')}><option value="invoice">An invoice</option><option value="customer">A customer (on account / advance)</option><option value="income">Direct income (no invoice)</option></Select>
          </Field>
          {v.linkTo === 'invoice' ? (
            <Field label="Related invoice" required error={f.errors.invoiceId} hint={invoices.data && !invoices.data.length ? 'No open invoices' : undefined}>
              <Select {...f.bind('invoiceId')}><option value="">Select an open invoice</option>{(invoices.data ?? []).map((i) => <option key={i.id} value={i.id}>{i.number} — {i.customer} — {formatMoney(i.outstanding, currency)} due</option>)}</Select>
            </Field>
          ) : v.linkTo === 'customer' ? (
            <Field label="Customer" required error={f.errors.customerId ?? f.errors.invoiceId}><Select {...f.bind('customerId')}><option value="">Select a customer</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          ) : (
            <Field label="Income category" required error={f.errors.categoryId ?? f.errors.invoiceId}><Select {...f.bind('categoryId')}><option value="">Select a category</option>{(categories.data ?? []).filter((c) => c.type === 'INCOME' && c.isActive && !c.isSystem).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          )}
          {v.linkTo === 'income' && <Field label="Customer" error={f.errors.customerId} hint="Optional"><Select {...f.bind('customerId')}><option value="">None</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>}
          <Field label="Payment method" required error={f.errors.method}><Select {...f.bind('method')}><option value="">Select a payment method</option>{ONLINE_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}</Select></Field>
          <Field label="Payment gateway / provider" error={f.errors.gateway} hint="e.g. Razorpay, PhonePe, bank name"><Input {...f.bind('gateway')} maxLength={40} /></Field>
          <Field label="Payment reference ID" error={f.errors.gatewayPaymentId} hint="Unique per provider — duplicates are rejected"><Input {...f.bind('gatewayPaymentId')} maxLength={100} /></Field>
          <Field label="Transaction date" required error={f.errors.date}><Input type="date" max={todayIso()} {...f.bind('date')} /></Field>
          <Field label="Settlement account" required error={f.errors.accountId}><Select {...f.bind('accountId')}><option value="">Select a bank account</option>{options.map((a) => <option key={a.id} value={a.id}>{accountLabel(a, currency)}</option>)}</Select></Field>
          <Field label={`Payment amount (${currency})`} required error={f.errors.amount}><Input inputMode="decimal" placeholder="0.00" {...f.bind('amount')} /></Field>
          <Field label={`Processing fee (${currency})`} error={f.errors.fee} hint={net > 0 && toPaise(v.fee) > 0 ? `Net settlement ${formatMoney(fromPaise(net), currency)}` : 'Charged by the provider, if any'}><Input inputMode="decimal" placeholder="0.00" {...f.bind('fee')} /></Field>
          <Field label="Payment status" required error={f.errors.status}><Select {...f.bind('status')}><option value="">Select a status</option><option value="SUCCESS">Successful — post to the books now</option><option value="PENDING">Pending — awaiting confirmation</option></Select></Field>
          <Field label="Notes" error={f.errors.notes} className="sm:col-span-2"><Textarea rows={2} {...f.bind('notes')} maxLength={500} /></Field>
        </div>
        {v.status === 'PENDING' && <Notice tone="amber">A pending payment is not posted. Confirm it as successful once the money has actually arrived.</Notice>}
        <Notice>Never enter card numbers, CVV or banking passwords. Only the provider's reference ID is needed.</Notice>
        <div className="flex justify-end gap-2 pt-1"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Record payment</Button></div>
      </form>
    </Modal>
  );
}

export function RefundDialog({ open, onClose, payment }: { open: boolean; onClose: () => void; payment: { id: string; number: string; amount: string; refundedAmount: string } | null }) {
  const { currency } = useAuth();
  const { busy, run } = useSubmit();
  const f = useForm({ amount: '', date: '', reason: '' });
  const refundable = payment ? fromPaise(toPaise(payment.amount) - toPaise(payment.refundedAmount)) : '0.00';
  useEffect(() => { if (open) f.reset({ amount: '', date: '', reason: '' }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, payment?.id]);
  if (!payment) return null;
  const submit = (e: FormEvent) => { e.preventDefault(); void run((key) => api.post(`/payments/${payment.id}/refund`, f.values, key), { success: 'Refund recorded', setErrors: f.setErrors, onDone: onClose }); };
  return (
    <Modal open={open} onClose={onClose} title={`Refund payment ${payment.number}`} description={`Refundable: ${formatMoney(refundable, currency)}`} size="sm">
      <form onSubmit={submit} noValidate className="space-y-4">
        <Notice tone="amber">This records a refund in the books (money leaves the settlement account). Issue the actual refund with your bank or payment provider.</Notice>
        <Field label={`Refund amount (${currency})`} required error={f.errors.amount}><Input inputMode="decimal" placeholder="0.00" {...f.bind('amount')} /></Field>
        <Field label="Refund date" required error={f.errors.date}><Input type="date" max={todayIso()} {...f.bind('date')} /></Field>
        <Field label="Reason" required error={f.errors.reason}><Textarea rows={2} {...f.bind('reason')} maxLength={500} /></Field>
        <div className="flex justify-end gap-2 pt-1"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" variant="danger" loading={busy}>Record refund</Button></div>
      </form>
    </Modal>
  );
}
