import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Paperclip, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAccounts, useCategories, useForm, useParties, useSettings, useSubmit, useTaxRates } from '../lib/hooks';
import type { Account } from '../lib/hooks';
import { todayIso } from '../lib/dates';
import { fileSize, formatMoney, fromPaise, METHOD_LABELS, toPaise } from '../lib/format';
import { Button, Checkbox, Field, Input, Modal, Notice, Select, Textarea } from './ui';

export type FormKind = 'INCOME' | 'EXPENSE' | 'TRANSFER' | 'ADJUSTMENT';
const TITLES: Record<FormKind, string> = { INCOME: 'Record income', EXPENSE: 'Record expense', TRANSFER: 'Transfer between accounts', ADJUSTMENT: 'Balance adjustment' };
const SETTLEMENT = ['CASH', 'BANK_TRANSFER', 'UPI', 'CREDIT_CARD', 'DEBIT_CARD', 'NET_BANKING', 'PAYMENT_GATEWAY', 'CHEQUE'];

export const accountLabel = (a: Account, currency: string) => `${a.name}${a.accountNumberMasked ? ` (${a.accountNumberMasked})` : ''} — ${formatMoney(a.balance, currency)}`;
/** Cash is paid from/into cash accounts; every other method settles through a bank account. */
export const accountsFor = (accounts: Account[] | undefined, method: string) =>
  (accounts ?? []).filter((a) => a.isActive && (method === 'CASH' ? a.kind === 'CASH' : method === 'OTHER' ? true : a.kind === 'BANK'));

interface Props { kind: FormKind | null; onClose: () => void; defaultAccountId?: string }

export function TransactionFormModal({ kind, onClose, defaultAccountId }: Props) {
  return (
    <Modal open={kind !== null} onClose={onClose} title={kind ? TITLES[kind] : ''} size={kind === 'INCOME' || kind === 'EXPENSE' ? 'lg' : 'md'}>
      {kind === 'INCOME' || kind === 'EXPENSE' ? <IncomeExpenseForm kind={kind} onClose={onClose} defaultAccountId={defaultAccountId} />
        : kind === 'TRANSFER' ? <TransferForm onClose={onClose} defaultAccountId={defaultAccountId} />
        : kind === 'ADJUSTMENT' ? <AdjustmentForm onClose={onClose} defaultAccountId={defaultAccountId} /> : null}
    </Modal>
  );
}

function Footer({ onClose, busy, label }: { onClose: () => void; busy: boolean; label: string }) {
  return (
    <div className="mt-5 flex justify-end gap-2 border-t border-slate-100 pt-4">
      <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
      <Button type="submit" loading={busy}>{label}</Button>
    </div>
  );
}

function IncomeExpenseForm({ kind, onClose, defaultAccountId }: { kind: 'INCOME' | 'EXPENSE'; onClose: () => void; defaultAccountId?: string }) {
  const { currency } = useAuth();
  const isIncome = kind === 'INCOME';
  const accounts = useAccounts();
  const categories = useCategories();
  const parties = useParties(isIncome ? 'customers' : 'suppliers');
  const taxRates = useTaxRates();
  const settings = useSettings();
  const { busy, run } = useSubmit();
  const defaultAccount = accounts.data?.find((a) => a.id === defaultAccountId);
  const f = useForm({
    date: todayIso(), categoryId: '', partyId: '', description: '', amount: '', taxAmount: '', taxRecoverable: false as boolean,
    paymentMethod: defaultAccount?.kind === 'BANK' ? 'BANK_TRANSFER' : 'CASH', accountId: defaultAccountId ?? '', reference: '', dueDate: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const v = f.values;
  const onCredit = v.paymentMethod === 'CREDIT';
  const options = accountsFor(accounts.data, v.paymentMethod);

  // Keep the chosen account consistent with the payment method.
  useEffect(() => {
    if (onCredit) { if (v.accountId) f.set('accountId', ''); return; }
    if (!accounts.data) return;
    if (!options.some((a) => a.id === v.accountId)) f.set('accountId', options.length === 1 ? options[0].id : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.paymentMethod, accounts.data]);

  const total = toPaise(v.amount) + toPaise(v.taxAmount);
  const applyRate = (rate: string) => { if (rate && toPaise(v.amount) > 0) f.set('taxAmount', fromPaise(Math.round((toPaise(v.amount) * Number(rate)) / 100))); };
  const showTax = Boolean(settings.data?.settings.taxEnabled) || toPaise(v.taxAmount) > 0;
  const needsApproval = !isIncome && settings.data?.settings.expenseApprovalRequired;

  const pick = (chosen: File | undefined) => {
    setFileError('');
    if (!chosen) return;
    if (chosen.size > 5 * 1024 * 1024) return setFileError('The file is larger than 5 MB.');
    if (!['image/png', 'image/jpeg', 'image/webp', 'application/pdf'].includes(chosen.type)) return setFileError('Only PNG, JPEG, WebP or PDF files are allowed.');
    setFile(chosen);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async (key) => {
      let attachmentId: string | undefined;
      if (file) {
        try { attachmentId = (await api.upload<{ id: string }>('/attachments', file)).data.id; }
        catch (err) { setFileError(err instanceof ApiError ? err.message : 'Upload failed'); throw err; }
      }
      return api.post(isIncome ? '/income' : '/expenses', {
        date: v.date, categoryId: v.categoryId, [isIncome ? 'customerId' : 'supplierId']: v.partyId, description: v.description, amount: v.amount,
        taxAmount: v.taxAmount, paymentMethod: v.paymentMethod, accountId: v.accountId, reference: v.reference, attachmentId,
        ...(isIncome ? {} : { taxRecoverable: v.taxRecoverable, dueDate: onCredit ? v.dueDate : '' }),
      }, key);
    }, {
      success: isIncome ? 'Income recorded' : needsApproval ? 'Expense submitted for approval' : 'Expense recorded',
      setErrors: (errs) => f.setErrors({ ...errs, partyId: errs.customerId ?? errs.supplierId ?? '' }),
      onDone: onClose,
    });
  };

  const cats = (categories.data ?? []).filter((c) => c.type === kind && c.isActive && !c.isSystem);
  return (
    <form onSubmit={submit} noValidate>
      {needsApproval && <div className="mb-4"><Notice tone="amber">Company policy requires approval. This expense will not affect balances or reports until an authorised person approves it.</Notice></div>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date" required error={f.errors.date}><Input type="date" max={todayIso()} {...f.bind('date')} /></Field>
        <Field label={isIncome ? 'Income category' : 'Expense category'} required error={f.errors.categoryId}>
          <Select {...f.bind('categoryId')}><option value="">Select a category</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        </Field>
        <Field label={isIncome ? 'Customer' : 'Supplier'} required={onCredit} error={f.errors.partyId} hint={onCredit ? 'Required for expenses on credit' : 'Optional'}>
          <Select {...f.bind('partyId')}><option value="">{isIncome ? 'Walk-in / none' : 'None'}</option>{(parties.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
        </Field>
        <Field label={isIncome ? 'Reference number' : 'Invoice or receipt number'} error={f.errors.reference}><Input {...f.bind('reference')} maxLength={100} /></Field>
        <Field label={`Amount (${currency})`} required error={f.errors.amount} hint={showTax ? 'Before tax' : undefined}><Input inputMode="decimal" placeholder="0.00" {...f.bind('amount')} /></Field>
        {showTax ? (
          <Field label={`${settings.data?.settings.taxLabel ?? 'Tax'} amount`} error={f.errors.taxAmount} hint="Leave empty if no tax applies">
            <div className="flex gap-2">
              <Input inputMode="decimal" placeholder="0.00" {...f.bind('taxAmount')} />
              {(taxRates.data ?? []).some((t) => t.isActive) && (
                <Select aria-label="Apply a tax rate" className="w-36 shrink-0" value="" onChange={(e) => applyRate(e.target.value)}>
                  <option value="">Apply rate…</option>
                  {(taxRates.data ?? []).filter((t) => t.isActive).map((t) => <option key={t.id} value={t.rate}>{t.name}</option>)}
                </Select>
              )}
            </div>
          </Field>
        ) : <div className="hidden sm:block" />}
        <Field label="Payment method" required error={f.errors.paymentMethod}>
          <Select {...f.bind('paymentMethod')}>
            {SETTLEMENT.map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
            {!isIncome && <option value="CREDIT">{METHOD_LABELS.CREDIT}</option>}
          </Select>
        </Field>
        {onCredit ? (
          <Field label="Payment due date" error={f.errors.dueDate} hint="Creates a payable to the supplier"><Input type="date" min={v.date} {...f.bind('dueDate')} /></Field>
        ) : (
          <Field label={isIncome ? 'Deposit to account' : 'Paid from account'} required error={f.errors.accountId} hint={options.length === 0 && accounts.data ? `No active ${v.paymentMethod === 'CASH' ? 'cash' : 'bank'} account. Create one first.` : undefined}>
            <Select {...f.bind('accountId')}><option value="">Select an account</option>{options.map((a) => <option key={a.id} value={a.id}>{accountLabel(a, currency)}</option>)}</Select>
          </Field>
        )}
        <Field label="Description" error={f.errors.description} className="sm:col-span-2"><Textarea {...f.bind('description')} maxLength={500} rows={2} /></Field>
        {!isIncome && toPaise(v.taxAmount) > 0 && (
          <div className="sm:col-span-2">
            <Checkbox label="This tax is recoverable as input credit" hint="Tick only if you are entitled to claim it. Otherwise the tax is treated as part of the expense." checked={v.taxRecoverable} onChange={(c) => f.set('taxRecoverable', c)} />
          </div>
        )}
        <div className="sm:col-span-2">
          <span className="mb-1 block text-sm font-medium text-slate-700">Attachment</span>
          <input ref={fileRef} type="file" className="sr-only" aria-label="Choose attachment" accept="image/png,image/jpeg,image/webp,application/pdf" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          {file ? (
            <div className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <span className="flex min-w-0 items-center gap-2"><Paperclip className="h-4 w-4 shrink-0 text-slate-400" /><span className="truncate">{file.name}</span><span className="shrink-0 text-xs text-slate-500">{fileSize(file.size)}</span></span>
              <button type="button" onClick={() => setFile(null)} className="rounded p-1 text-slate-400 hover:text-slate-600" aria-label="Remove attachment"><X className="h-4 w-4" /></button>
            </div>
          ) : <Button variant="secondary" size="sm" icon={<Paperclip className="h-3.5 w-3.5" />} onClick={() => fileRef.current?.click()}>Attach receipt or invoice</Button>}
          {fileError ? <p className="mt-1 text-xs font-medium text-rose-600" role="alert">{fileError}</p> : !file && <p className="mt-1 text-xs text-slate-500">PNG, JPEG, WebP or PDF, up to 5 MB.</p>}
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between rounded-md bg-slate-50 px-3.5 py-2.5 text-sm">
        <span className="text-slate-600">Total {isIncome ? 'received' : onCredit ? 'payable' : 'paid'}</span>
        <span className="text-base font-semibold tabular-nums text-slate-900">{formatMoney(fromPaise(total), currency)}</span>
      </div>
      <Footer onClose={onClose} busy={busy} label={isIncome ? 'Save income' : 'Save expense'} />
    </form>
  );
}

function TransferForm({ onClose, defaultAccountId }: { onClose: () => void; defaultAccountId?: string }) {
  const { currency } = useAuth();
  const accounts = useAccounts();
  const { busy, run } = useSubmit();
  const f = useForm({ date: todayIso(), fromAccountId: defaultAccountId ?? '', toAccountId: '', amount: '', description: '', reference: '' });
  const active = (accounts.data ?? []).filter((a) => a.isActive);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run((key) => api.post('/transactions', { type: 'TRANSFER', ...f.values }, key), { success: 'Transfer recorded', setErrors: f.setErrors, onDone: onClose });
  };
  return (
    <form onSubmit={submit} noValidate>
      <p className="mb-4 text-sm text-slate-500">Use this for cash deposits, withdrawals and moving money between your own accounts. Transfers do not affect profit.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="From account" required error={f.errors.fromAccountId}>
          <Select {...f.bind('fromAccountId')}><option value="">Select an account</option>{active.map((a) => <option key={a.id} value={a.id}>{accountLabel(a, currency)}</option>)}</Select>
        </Field>
        <Field label="To account" required error={f.errors.toAccountId}>
          <Select {...f.bind('toAccountId')}><option value="">Select an account</option>{active.filter((a) => a.id !== f.values.fromAccountId).map((a) => <option key={a.id} value={a.id}>{accountLabel(a, currency)}</option>)}</Select>
        </Field>
        <Field label="Date" required error={f.errors.date}><Input type="date" max={todayIso()} {...f.bind('date')} /></Field>
        <Field label={`Amount (${currency})`} required error={f.errors.amount}><Input inputMode="decimal" placeholder="0.00" {...f.bind('amount')} /></Field>
        <Field label="Reference number" error={f.errors.reference}><Input {...f.bind('reference')} maxLength={100} /></Field>
        <Field label="Description" error={f.errors.description}><Input {...f.bind('description')} maxLength={500} /></Field>
      </div>
      <Footer onClose={onClose} busy={busy} label="Record transfer" />
    </form>
  );
}

function AdjustmentForm({ onClose, defaultAccountId }: { onClose: () => void; defaultAccountId?: string }) {
  const { currency } = useAuth();
  const accounts = useAccounts();
  const { busy, run } = useSubmit();
  const f = useForm({ date: todayIso(), accountId: defaultAccountId ?? '', direction: 'DECREASE', amount: '', reason: '', reference: '' });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run((key) => api.post('/transactions', { type: 'ADJUSTMENT', ...f.values }, key), { success: 'Adjustment posted', setErrors: f.setErrors, onDone: onClose });
  };
  return (
    <form onSubmit={submit} noValidate>
      <div className="mb-4"><Notice tone="amber">Balances cannot be edited directly. An adjustment posts a real accounting entry (to other income or other expenses), needs a reason, and is recorded in the audit log.</Notice></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Account" required error={f.errors.accountId} className="sm:col-span-2">
          <Select {...f.bind('accountId')}><option value="">Select an account</option>{(accounts.data ?? []).filter((a) => a.isActive).map((a) => <option key={a.id} value={a.id}>{accountLabel(a, currency)}</option>)}</Select>
        </Field>
        <Field label="Adjustment" required error={f.errors.direction}>
          <Select {...f.bind('direction')}><option value="DECREASE">Decrease balance (shortage)</option><option value="INCREASE">Increase balance (excess)</option></Select>
        </Field>
        <Field label={`Amount (${currency})`} required error={f.errors.amount}><Input inputMode="decimal" placeholder="0.00" {...f.bind('amount')} /></Field>
        <Field label="Date" required error={f.errors.date}><Input type="date" max={todayIso()} {...f.bind('date')} /></Field>
        <Field label="Reference number" error={f.errors.reference}><Input {...f.bind('reference')} maxLength={100} /></Field>
        <Field label="Reason" required error={f.errors.reason} className="sm:col-span-2"><Textarea {...f.bind('reason')} maxLength={500} rows={2} placeholder="e.g. Till short after daily count" /></Field>
      </div>
      <Footer onClose={onClose} busy={busy} label="Post adjustment" />
    </form>
  );
}
