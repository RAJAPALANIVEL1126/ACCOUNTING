import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useForm, useSettings, useSubmit, useTaxRates } from '../lib/hooks';
import type { Category, SettingsPayload } from '../lib/hooks';
import { titleCase } from '../lib/format';
import { Badge, Button, Card, CardHeader, Checkbox, DescriptionList, ErrorState, Field, Input, Loading, Notice, PageHeader, Select, Tabs, Textarea } from '../components/ui';

type Tab = 'accounting' | 'categories' | 'tax' | 'invoice' | 'gateway' | 'notifications' | 'security' | 'backup';
type S = SettingsPayload['settings'];

const INCOME_GROUPS = ['SALES_REVENUE', 'OTHER_OPERATING_INCOME'];
const EXPENSE_GROUPS = ['COST_OF_GOODS_SOLD', 'DIRECT_COST', 'EMPLOYEE', 'RENT_UTILITIES', 'MARKETING', 'TRANSPORTATION', 'ADMINISTRATIVE', 'OTHER_EXPENSE'];
const GROUP_LABELS: Record<string, string> = {
  SALES_REVENUE: 'Sales Revenue', OTHER_OPERATING_INCOME: 'Other Operating Income', COST_OF_GOODS_SOLD: 'Cost of Goods Sold', DIRECT_COST: 'Direct Costs', EMPLOYEE: 'Employee Expenses',
  RENT_UTILITIES: 'Rent and Utilities', MARKETING: 'Marketing Expenses', TRANSPORTATION: 'Transportation Expenses', ADMINISTRATIVE: 'Administrative Expenses', OTHER_EXPENSE: 'Other Expenses',
};

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <Card className="mb-5"><CardHeader title={title} description={description} /><div className="p-5">{children}</div></Card>;
}

/** Saves a partial settings patch. Every change is written to the audit log by the server. */
function useSaveSettings() {
  const { busy, run } = useSubmit();
  return { busy, save: (patch: Partial<S>, setErrors?: (e: Record<string, string>) => void) => run(() => api.patch('/settings', patch), { success: 'Settings saved', setErrors }) };
}

function Accounting({ s }: { s: S }) {
  const { busy, save } = useSaveSettings();
  const [v, setV] = useState({ accountingMethod: s.accountingMethod, expenseApprovalRequired: s.expenseApprovalRequired, allowSelfApproval: s.allowSelfApproval });
  const dirty = v.accountingMethod !== s.accountingMethod || v.expenseApprovalRequired !== s.expenseApprovalRequired || v.allowSelfApproval !== s.allowSelfApproval;
  return (
    <>
      <Section title="Accounting method" description="Decides when income and expenses count towards profit. It is shown on every report.">
        <div className="space-y-3">
          {([['ACCRUAL', 'Accrual basis', 'Income counts when an invoice is issued or a sale is made; expenses when they are incurred — even if not yet paid. Recommended for most businesses and required for formal accounts.'],
            ['CASH', 'Cash basis', 'Income counts only when money is received and expenses only when money is paid. Unpaid invoices and unpaid supplier bills are left out of profit until settled.']] as const).map(([value, label, hint]) => (
            <label key={value} className={`flex cursor-pointer items-start gap-3 rounded-md border p-3.5 ${v.accountingMethod === value ? 'border-brand-500 bg-brand-50/50' : 'border-slate-200'}`}>
              <input type="radio" name="method" className="mt-1 h-4 w-4 text-brand-600" checked={v.accountingMethod === value} onChange={() => setV({ ...v, accountingMethod: value })} />
              <span><span className="block text-sm font-semibold text-slate-900">{label}</span><span className="block text-sm text-slate-600">{hint}</span></span>
            </label>
          ))}
          <Notice>Changing the method does not alter any recorded entry or any balance. It only changes how profit is measured in dashboards and reports. Financial year and currency are set under <Link className="font-semibold underline" to="/company">Company Details</Link>.</Notice>
        </div>
      </Section>
      <Section title="Expense approval" description="Add a review step before an expense reaches the books.">
        <div className="space-y-3">
          <Checkbox label="Require approval for expenses" hint="New expenses wait as “Pending approval” and do not affect balances or reports until an Admin approves them." checked={v.expenseApprovalRequired} onChange={(c) => setV({ ...v, expenseApprovalRequired: c })} />
          <Checkbox label="Allow approvers to approve their own expenses" hint="Leave off to enforce independent approval (recommended)." checked={v.allowSelfApproval} disabled={!v.expenseApprovalRequired} onChange={(c) => setV({ ...v, allowSelfApproval: c })} />
        </div>
      </Section>
      <div className="flex justify-end"><Button loading={busy} disabled={!dirty} onClick={() => save(v)}>Save accounting settings</Button></div>
    </>
  );
}

function Categories() {
  const q = useQuery({ queryKey: ['categories', 'all'], queryFn: async () => (await api.get<Category[]>('/categories', { includeInactive: 1 })).data });
  const { busy, run } = useSubmit();
  const f = useForm({ name: '', type: 'EXPENSE', plGroup: 'OTHER_EXPENSE' });
  const groups = f.values.type === 'INCOME' ? INCOME_GROUPS : EXPENSE_GROUPS;
  useEffect(() => { if (!groups.includes(f.values.plGroup)) f.set('plGroup', groups[groups.length - 1]); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [f.values.type]);
  const add = (e: FormEvent) => { e.preventDefault(); void run(() => api.post('/categories', f.values), { success: 'Category added', setErrors: f.setErrors, onDone: () => f.set('name', '') }); };
  if (q.isLoading) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <>
      <Section title="Add a category" description="The report group decides where the category appears in the Profit and Loss statement.">
        <form onSubmit={add} noValidate className="grid items-start gap-4 sm:grid-cols-[1fr_160px_220px_auto]">
          <Field label="Category name" required error={f.errors.name}><Input {...f.bind('name')} maxLength={80} /></Field>
          <Field label="Type" required><Select {...f.bind('type')}><option value="INCOME">Income</option><option value="EXPENSE">Expense</option></Select></Field>
          <Field label="Report group" required error={f.errors.plGroup}><Select {...f.bind('plGroup')}>{groups.map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}</Select></Field>
          <div className="sm:pt-6"><Button type="submit" loading={busy} icon={<Plus className="h-4 w-4" />}>Add</Button></div>
        </form>
      </Section>
      {(['INCOME', 'EXPENSE'] as const).map((type) => (
        <Card key={type} className="mb-5">
          <CardHeader title={type === 'INCOME' ? 'Income categories' : 'Expense categories'} />
          <div className="table-wrap">
            <table className="table">
              <thead className="bg-slate-50"><tr><th className="th">Name</th><th className="th">Report group</th><th className="th">Status</th><th className="th" /></tr></thead>
              <tbody>
                {(q.data ?? []).filter((c) => c.type === type).map((c) => (
                  <tr key={c.id}>
                    <td className="td font-medium text-slate-900">{c.name} {c.isSystem && <Badge>System</Badge>}</td>
                    <td className="td">{c.isSystem ? GROUP_LABELS[c.plGroup] : (
                      <Select aria-label={`Report group for ${c.name}`} className="w-56 py-1" value={c.plGroup} disabled={busy} onChange={(e) => run(() => api.patch(`/categories/${c.id}`, { plGroup: e.target.value }), { success: 'Category updated' })}>
                        {(type === 'INCOME' ? INCOME_GROUPS : EXPENSE_GROUPS).map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}
                      </Select>
                    )}</td>
                    <td className="td"><Badge tone={c.isActive ? 'green' : 'slate'}>{c.isActive ? 'Active' : 'Inactive'}</Badge></td>
                    <td className="td text-right">{!c.isSystem && <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => api.patch(`/categories/${c.id}`, { isActive: !c.isActive }), { success: 'Category updated' })}>{c.isActive ? 'Deactivate' : 'Activate'}</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ))}
      <p className="text-xs text-slate-500">Categories with history cannot be deleted, only deactivated, so past reports stay intact. A recorded expense is not automatically tax-deductible.</p>
    </>
  );
}

function Tax({ s }: { s: S }) {
  const rates = useTaxRates();
  const { busy, save } = useSaveSettings();
  const add = useSubmit();
  const [v, setV] = useState({ taxEnabled: s.taxEnabled, taxLabel: s.taxLabel });
  const f = useForm({ name: '', rate: '' });
  const submit = (e: FormEvent) => { e.preventDefault(); void add.run(() => api.post('/tax-rates', f.values), { success: 'Tax rate added', setErrors: f.setErrors, onDone: () => f.reset({ name: '', rate: '' }) }); };
  return (
    <>
      <Section title="Tax configuration" description="Tax is optional. Not every business or transaction is subject to GST.">
        <div className="space-y-4">
          <Checkbox label="This company charges or records tax" hint="Shows tax fields on income, expenses and invoices. Each line can still be left at 0%." checked={v.taxEnabled} onChange={(c) => setV({ ...v, taxEnabled: c })} />
          <Field label="Tax label" hint="Printed on invoices, e.g. GST or VAT" className="max-w-xs"><Input value={v.taxLabel} maxLength={20} onChange={(e) => setV({ ...v, taxLabel: e.target.value })} /></Field>
          <Button loading={busy} disabled={v.taxEnabled === s.taxEnabled && v.taxLabel === s.taxLabel} onClick={() => save(v)}>Save tax settings</Button>
        </div>
      </Section>
      <Card>
        <CardHeader title="Tax rates" description="Rates offered when entering transactions and invoice lines" />
        <form onSubmit={submit} noValidate className="grid items-start gap-4 border-b border-slate-100 p-5 sm:grid-cols-[1fr_160px_auto]">
          <Field label="Name" required error={f.errors.name}><Input placeholder="e.g. GST 18%" {...f.bind('name')} maxLength={40} /></Field>
          <Field label="Rate (%)" required error={f.errors.rate}><Input inputMode="decimal" placeholder="18" {...f.bind('rate')} /></Field>
          <div className="sm:pt-6"><Button type="submit" loading={add.busy} icon={<Plus className="h-4 w-4" />}>Add rate</Button></div>
        </form>
        {rates.isLoading ? <Loading /> : !rates.data?.length ? <p className="px-5 py-8 text-center text-sm text-slate-500">No tax rates configured.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead className="bg-slate-50"><tr><th className="th">Name</th><th className="th num">Rate</th><th className="th">Status</th><th className="th" /></tr></thead>
              <tbody>
                {rates.data.map((t) => (
                  <tr key={t.id}>
                    <td className="td font-medium text-slate-900">{t.name}</td><td className="td num">{Number(t.rate)}%</td>
                    <td className="td"><Badge tone={t.isActive ? 'green' : 'slate'}>{t.isActive ? 'Active' : 'Inactive'}</Badge></td>
                    <td className="td text-right"><Button variant="ghost" size="sm" disabled={add.busy} onClick={() => add.run(() => api.patch(`/tax-rates/${t.id}`, { isActive: !t.isActive }), { success: 'Tax rate updated' })}>{t.isActive ? 'Deactivate' : 'Activate'}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function Invoice({ s }: { s: S }) {
  const { busy, save } = useSaveSettings();
  const f = useForm({ invoicePrefix: s.invoicePrefix, invoiceDueDays: String(s.invoiceDueDays), invoiceNotes: s.invoiceNotes ?? '', invoiceTerms: s.invoiceTerms ?? '' });
  const submit = (e: FormEvent) => { e.preventDefault(); void save({ ...f.values, invoiceDueDays: Number(f.values.invoiceDueDays) } as Partial<S>, f.setErrors); };
  return (
    <Section title="Invoice configuration" description="Defaults applied to new invoices. Existing invoices are not changed.">
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Invoice number prefix" error={f.errors.invoicePrefix} hint={`Next numbers look like ${f.values.invoicePrefix}00001`}><Input {...f.bind('invoicePrefix')} maxLength={12} /></Field>
          <Field label="Default payment terms (days)" error={f.errors.invoiceDueDays} hint="Due date = invoice date + this many days"><Input inputMode="numeric" {...f.bind('invoiceDueDays')} /></Field>
        </div>
        <Field label="Default notes to customer" error={f.errors.invoiceNotes}><Textarea rows={2} {...f.bind('invoiceNotes')} maxLength={1000} /></Field>
        <Field label="Default terms and conditions" error={f.errors.invoiceTerms}><Textarea rows={3} {...f.bind('invoiceTerms')} maxLength={2000} /></Field>
        <div className="flex justify-end"><Button type="submit" loading={busy}>Save invoice settings</Button></div>
      </form>
    </Section>
  );
}

function Notifications({ s, emailConfigured }: { s: S; emailConfigured: boolean }) {
  const { busy, save } = useSaveSettings();
  const [v, setV] = useState({ notifyExpenseApproval: s.notifyExpenseApproval, notifyPaymentReceived: s.notifyPaymentReceived });
  return (
    <Section title="Notification settings" description="Email notifications sent by the system.">
      <div className="space-y-4">
        {!emailConfigured && <Notice tone="amber" title="Outgoing email is not configured">Set the SMTP variables on the server to deliver email. Until then, notifications, verification links and password links cannot reach users.</Notice>}
        <Checkbox label="Email approvers when an expense needs approval" hint="Sent to Admins and Super Admins when expense approval is enabled." checked={v.notifyExpenseApproval} onChange={(c) => setV({ ...v, notifyExpenseApproval: c })} />
        <Button loading={busy} disabled={v.notifyExpenseApproval === s.notifyExpenseApproval} onClick={() => save(v)}>Save notification settings</Button>
      </div>
    </Section>
  );
}

function Gateway({ g }: { g: SettingsPayload['gateway'] }) {
  return (
    <Section title="Payment gateway" description="Optional online payment collection through Razorpay.">
      <div className="space-y-4">
        <Notice tone={g.configured ? 'green' : 'amber'} title={g.configured ? 'Razorpay is configured' : 'Transaction-recording mode'}>{g.message}</Notice>
        <DescriptionList items={[['Provider', g.configured ? 'Razorpay' : 'None'], ['Mode', g.configured ? 'Live collection enabled' : 'Recording only'], ['Public key ID', g.keyId ?? 'Not set'], ['Webhook URL', `${window.location.origin}/api/webhooks/razorpay`]]} />
        <div className="text-sm text-slate-600">
          <p className="font-medium text-slate-800">To enable collection</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            <li>Create API keys and a webhook secret in the Razorpay dashboard.</li>
            <li>Set <code className="rounded bg-slate-100 px-1 text-xs">RAZORPAY_KEY_ID</code>, <code className="rounded bg-slate-100 px-1 text-xs">RAZORPAY_KEY_SECRET</code> and <code className="rounded bg-slate-100 px-1 text-xs">RAZORPAY_WEBHOOK_SECRET</code> in the server environment and restart it.</li>
            <li>Point a Razorpay webhook at the URL above for <i>payment.captured</i>, <i>payment.failed</i> and <i>refund.processed</i>.</li>
          </ol>
          <p className="mt-2 text-xs text-slate-500">Secrets are read from the server environment only. They are never stored in the database, shown here, or sent to the browser. Card numbers and CVV are never handled by this application.</p>
        </div>
      </div>
    </Section>
  );
}

function Security({ sec }: { sec: SettingsPayload['security'] }) {
  const { busy, run } = useSubmit();
  const f = useForm({ currentPassword: '', newPassword: '', confirm: '' });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (f.values.newPassword !== f.values.confirm) return f.setErrors({ confirm: 'Passwords do not match' });
    void run(() => api.post('/auth/change-password', { currentPassword: f.values.currentPassword, newPassword: f.values.newPassword }), { success: 'Password changed. Other sessions were signed out.', setErrors: f.setErrors, onDone: () => f.reset({ currentPassword: '', newPassword: '', confirm: '' }) });
  };
  return (
    <>
      <Section title="Security policy" description="Enforced by the server for every user.">
        <DescriptionList items={[
          ['Password hashing', 'Argon2id'], ['Minimum password length', `${sec.passwordMinLength} characters, with a letter and a number`],
          ['Account lockout', `${sec.maxFailedLogins} failed attempts → locked for ${sec.lockMinutes} minutes`], ['Session lifetime', `${sec.sessionTtlHours} hours`],
          ['Session cookie', `HTTP-only, SameSite=Lax${sec.secureCookies ? ', Secure (HTTPS only)' : ' — Secure flag is off (development)'}`], ['Request protection', 'CSRF token, rate limiting, security headers'],
          ['Outgoing email', sec.emailConfigured ? 'Configured' : 'Not configured'],
        ]} />
      </Section>
      <Section title="Change your password" description="You will stay signed in here; all your other sessions are signed out.">
        <form onSubmit={submit} noValidate className="grid max-w-xl gap-4">
          <Field label="Current password" required error={f.errors.currentPassword}><Input type="password" autoComplete="current-password" {...f.bind('currentPassword')} /></Field>
          <Field label="New password" required error={f.errors.newPassword}><Input type="password" autoComplete="new-password" {...f.bind('newPassword')} /></Field>
          <Field label="Confirm new password" required error={f.errors.confirm}><Input type="password" autoComplete="new-password" {...f.bind('confirm')} /></Field>
          <div><Button type="submit" loading={busy}>Change password</Button></div>
        </form>
      </Section>
    </>
  );
}

function Backup() {
  return (
    <Section title="Backup information" description="How this company's data is protected.">
      <div className="space-y-3 text-sm text-slate-600">
        <Notice tone="amber">Backups are an operational task of whoever hosts this application. They are not performed from this screen.</Notice>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>All accounting data lives in the PostgreSQL database. Uploaded logos and receipts live in the server's upload folder. <b>Both</b> must be backed up.</li>
          <li>Recommended: a nightly <code className="rounded bg-slate-100 px-1 text-xs">pg_dump</code> plus continuous WAL archiving (point-in-time recovery), kept off-site and encrypted, with at least 30 days of history.</li>
          <li>Test a restore at least quarterly. A backup that has never been restored is not a backup.</li>
          <li>Step-by-step backup and recovery instructions are in the project's <b>README.md</b> (section “Backup and recovery”).</li>
        </ul>
        <p>You can also export any report or the full transaction register to CSV, Excel or PDF from the Reports and Transactions pages for your own records.</p>
      </div>
    </Section>
  );
}

export default function Settings() {
  const { user } = useAuth();
  const q = useSettings();
  const [tab, setTab] = useState<Tab>('accounting');
  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;
  const { settings: s, gateway, security } = q.data;
  const key = JSON.stringify(s);
  return (
    <>
      <PageHeader title="Settings" description={<>Company-wide configuration. Changes are recorded in the audit log. Company profile, logo, currency and financial year are under <Link className="text-brand-600 hover:underline" to="/company">Company Details</Link>; roles under <Link className="text-brand-600 hover:underline" to="/users">User Accounts</Link>.</>} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { value: 'accounting', label: 'Accounting' }, { value: 'categories', label: 'Transaction categories' }, { value: 'tax', label: 'Tax' }, { value: 'invoice', label: 'Invoices' },
        { value: 'gateway', label: 'Payment gateway' }, { value: 'notifications', label: 'Notifications' }, { value: 'security', label: 'Security' }, { value: 'backup', label: 'Backup' },
      ]} />
      <div className="max-w-4xl">
        {tab === 'accounting' && <Accounting key={key} s={s} />}
        {tab === 'categories' && <Categories />}
        {tab === 'tax' && <Tax key={key} s={s} />}
        {tab === 'invoice' && <Invoice key={key} s={s} />}
        {tab === 'gateway' && <Gateway g={gateway} />}
        {tab === 'notifications' && <Notifications key={key} s={s} emailConfigured={security.emailConfigured} />}
        {tab === 'security' && <Security sec={security} />}
        {tab === 'backup' && <Backup />}
      </div>
      <p className="mt-6 text-xs text-slate-400">Signed in as {user?.email} ({titleCase(user?.role)})</p>
    </>
  );
}
