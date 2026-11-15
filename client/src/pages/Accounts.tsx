import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeftRight, Banknote, Landmark, Plus, SlidersHorizontal } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAccounts, useForm, useSubmit } from '../lib/hooks';
import type { Account } from '../lib/hooks';
import { todayIso } from '../lib/dates';
import { formatDate, titleCase } from '../lib/format';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, Loading, Modal, Money, Notice, PageHeader, Select } from '../components/ui';
import { TransactionFormModal } from '../components/TransactionForms';
import type { FormKind } from '../components/TransactionForms';

const COPY = {
  CASH: { title: 'Cash Management', description: 'Cash in hand: receipts, payments, deposits to bank and audited adjustments.', icon: Banknote, noun: 'cash account' },
  BANK: { title: 'Bank Accounts', description: 'Book balances from recorded entries and imported statements. No live bank connection is made.', icon: Landmark, noun: 'bank account' },
};

function AccountFormModal({ kind, open, onClose }: { kind: 'CASH' | 'BANK'; open: boolean; onClose: () => void }) {
  const { currency } = useAuth();
  const { busy, run } = useSubmit();
  const f = useForm({ name: '', bankName: '', bankAccountType: 'CURRENT', accountNumber: '', openingBalance: '', openingDate: todayIso() });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run((key) => api.post('/accounts', { kind, ...f.values }, key), {
      success: `${titleCase(kind)} account created`, setErrors: f.setErrors,
      onDone: () => { f.reset({ name: '', bankName: '', bankAccountType: 'CURRENT', accountNumber: '', openingBalance: '', openingDate: todayIso() }); onClose(); },
    });
  };
  return (
    <Modal open={open} onClose={onClose} title={`New ${COPY[kind].noun}`}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Account display name" required error={f.errors.name}><Input autoFocus placeholder={kind === 'CASH' ? 'e.g. Petty Cash' : 'e.g. HDFC Current Account'} {...f.bind('name')} /></Field>
        {kind === 'BANK' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Bank name" required error={f.errors.bankName}><Input {...f.bind('bankName')} /></Field>
            <Field label="Account type" error={f.errors.bankAccountType}>
              <Select {...f.bind('bankAccountType')}>{['CURRENT', 'SAVINGS', 'OVERDRAFT', 'CASH_CREDIT', 'OTHER'].map((t) => <option key={t} value={t}>{titleCase(t)}</option>)}</Select>
            </Field>
            <Field label="Account number" error={f.errors.accountNumber} hint="Only the last 4 digits are stored" className="sm:col-span-2"><Input inputMode="numeric" autoComplete="off" {...f.bind('accountNumber')} /></Field>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`Opening balance (${currency})`} error={f.errors.openingBalance} hint="Posted as an opening entry"><Input inputMode="decimal" placeholder="0.00" {...f.bind('openingBalance')} /></Field>
          <Field label="Opening balance date" error={f.errors.openingDate}><Input type="date" max={todayIso()} {...f.bind('openingDate')} /></Field>
        </div>
        {kind === 'BANK' && <Notice>Never enter internet-banking passwords, PINs or card details here. This application does not need or store them.</Notice>}
        <div className="flex justify-end gap-2 pt-1"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Create account</Button></div>
      </form>
    </Modal>
  );
}

export default function Accounts({ kind }: { kind: 'CASH' | 'BANK' }) {
  const copy = COPY[kind];
  const { can } = useAuth();
  const q = useAccounts();
  const { run } = useSubmit();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{ kind: FormKind; accountId?: string } | null>(null);
  const [toggle, setToggle] = useState<Account | null>(null);

  const accounts = (q.data ?? []).filter((a) => a.kind === kind);
  const total = accounts.reduce((sum, a) => sum + Math.round(Number(a.balance) * 100), 0) / 100;
  const Icon = copy.icon;

  return (
    <>
      <PageHeader
        title={copy.title}
        description={copy.description}
        actions={
          <>
            {can('transactions.create') && <Button variant="secondary" icon={<ArrowLeftRight className="h-4 w-4" />} onClick={() => setForm({ kind: 'TRANSFER' })}>{kind === 'CASH' ? 'Cash transfer' : 'Bank transfer'}</Button>}
            {can('adjustments.create') && <Button variant="secondary" icon={<SlidersHorizontal className="h-4 w-4" />} onClick={() => setForm({ kind: 'ADJUSTMENT' })}>Adjustment</Button>}
            {can('accounts.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New {copy.noun}</Button>}
          </>
        }
      />

      {q.isLoading ? <Loading /> : q.isError ? <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card> : (
        <>
          <Card className="mb-5 flex flex-wrap items-center justify-between gap-4 p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-md bg-navy-800 text-white"><Icon className="h-5 w-5" aria-hidden /></span>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Total {kind === 'CASH' ? 'cash' : 'bank'} balance · today</p>
                <Money value={total.toFixed(2)} className="text-2xl font-semibold text-slate-900" />
              </div>
            </div>
            <p className="max-w-md text-xs text-slate-500">Closing balance = opening balance + inflows − outflows. Balances are always calculated from posted entries and cannot be typed in.</p>
          </Card>

          {accounts.length === 0 ? (
            <Card><EmptyState icon={<Icon className="h-5 w-5" />} title={`No ${copy.noun}s yet`} message={kind === 'BANK' ? 'Add a bank account to record bank receipts, payments, UPI and card transactions.' : 'Add a cash account to start recording cash transactions.'} action={can('accounts.manage') ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New {copy.noun}</Button> : undefined} /></Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {accounts.map((a) => (
                <Card key={a.id} className="flex flex-col p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h2 className="truncate text-base font-semibold text-slate-900">{a.name}</h2>
                      <p className="mt-0.5 truncate text-xs text-slate-500">
                        {kind === 'BANK' ? [a.bankName, a.bankAccountType ? titleCase(a.bankAccountType) : null, a.accountNumberMasked].filter(Boolean).join(' · ') : `Code ${a.code}`}
                      </p>
                    </div>
                    <Badge tone={a.isActive ? 'green' : 'slate'}>{a.isActive ? 'Active' : 'Inactive'}</Badge>
                  </div>
                  <p className="mt-4 text-xs font-medium uppercase tracking-wide text-slate-500">Current book balance</p>
                  <Money value={a.balance} className="text-2xl font-semibold text-slate-900" />
                  <p className="mt-1 text-xs text-slate-500">Opening balance <Money value={a.openingBalance} />{a.openingDate ? ` on ${formatDate(a.openingDate)}` : ''}</p>
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
                    <Link to={`/accounts/${a.id}`}><Button variant="secondary" size="sm">{kind === 'BANK' ? 'History & reconciliation' : 'Transaction history'}</Button></Link>
                    {a.isActive && can('transactions.create') && <Button variant="ghost" size="sm" onClick={() => setForm({ kind: 'TRANSFER', accountId: a.id })}>Transfer</Button>}
                    {can('accounts.manage') && <Button variant="ghost" size="sm" onClick={() => setToggle(a)}>{a.isActive ? 'Deactivate' : 'Activate'}</Button>}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <AccountFormModal kind={kind} open={creating} onClose={() => setCreating(false)} />
      <TransactionFormModal kind={form?.kind ?? null} defaultAccountId={form?.accountId} onClose={() => setForm(null)} />
      <ConfirmDialog
        open={Boolean(toggle)} onClose={() => setToggle(null)} title={`${toggle?.isActive ? 'Deactivate' : 'Activate'} ${toggle?.name ?? ''}?`} confirmLabel={toggle?.isActive ? 'Deactivate' : 'Activate'} danger={toggle?.isActive}
        message={toggle?.isActive ? 'An inactive account keeps its history but cannot be used in new transactions. Only accounts with a zero balance can be deactivated.' : 'The account will be available for new transactions again.'}
        onConfirm={async () => { const r = await run(() => api.patch(`/accounts/${toggle!.id}`, { isActive: !toggle!.isActive }), { success: 'Account updated' }); if (r === undefined) throw new Error('The account could not be updated. Check that its balance is zero.'); }}
      />
    </>
  );
}
