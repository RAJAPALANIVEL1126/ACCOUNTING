import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useCategories, useParties, useSettings, useSubmit, useTaxRates } from '../lib/hooks';
import { addDays, todayIso } from '../lib/dates';
import { formatMoney, fromPaise, toPaise } from '../lib/format';
import { Button, Card, ErrorState, Field, Input, Loading, Notice, PageHeader, Select, Textarea } from '../components/ui';

interface Item { key: number; description: string; quantity: string; unitPrice: string; discount: string; taxRate: string; categoryId: string }
interface Existing { id: string; number: string; storedStatus: string; customerId: string; issueDate: string; dueDate: string; notes: string | null; terms: string | null; items: Array<Omit<Item, 'key'>> }

let nextKey = 1;
const blankItem = (categoryId = ''): Item => ({ key: nextKey++, description: '', quantity: '1', unitPrice: '', discount: '', taxRate: '0', categoryId });

/** Preview only, in integer paise. The server recalculates every figure when the invoice is saved. */
function preview(it: Item) {
  const qty = Number(it.quantity);
  const gross = Number.isFinite(qty) && qty > 0 ? Math.round(qty * toPaise(it.unitPrice)) : 0;
  const net = Math.max(0, gross - toPaise(it.discount));
  const rate = Number(it.taxRate);
  const tax = Number.isFinite(rate) && rate > 0 ? Math.round((net * rate) / 100) : 0;
  return { gross, discount: gross - net, net, tax, total: net + tax };
}

export default function InvoiceForm() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { currency } = useAuth();
  const customers = useParties('customers');
  const categories = useCategories();
  const taxRates = useTaxRates();
  const settings = useSettings();
  const existing = useQuery({ queryKey: ['invoice', id], queryFn: async () => (await api.get<Existing>(`/invoices/${id}`)).data, enabled: editing });
  const { busy, run } = useSubmit();

  const [head, setHead] = useState({ customerId: params.get('customerId') ?? '', issueDate: todayIso(), dueDate: '', notes: '', terms: '' });
  const [items, setItems] = useState<Item[]>([blankItem()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(!editing);
  const incomeCats = (categories.data ?? []).filter((c) => c.type === 'INCOME' && c.isActive && !c.isSystem);
  const s = settings.data?.settings;
  const taxLabel = s?.taxLabel ?? 'Tax';

  useEffect(() => {
    if (!editing && s && !head.dueDate) setHead((h) => ({ ...h, dueDate: addDays(h.issueDate, s.invoiceDueDays), notes: h.notes || s.invoiceNotes || '', terms: h.terms || s.invoiceTerms || '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, editing]);
  useEffect(() => {
    if (!existing.data || loaded) return;
    const e = existing.data;
    setHead({ customerId: e.customerId, issueDate: e.issueDate, dueDate: e.dueDate, notes: e.notes ?? '', terms: e.terms ?? '' });
    setItems(e.items.map((it) => ({ ...it, key: nextKey++, discount: Number(it.discount) ? it.discount : '', taxRate: String(Number(it.taxRate)) })));
    setLoaded(true);
  }, [existing.data, loaded]);
  useEffect(() => {
    if (incomeCats.length && items.some((it) => !it.categoryId)) setItems((list) => list.map((it) => (it.categoryId ? it : { ...it, categoryId: incomeCats[0].id })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomeCats.length]);

  const setItem = (key: number, patch: Partial<Item>) => { setItems((list) => list.map((it) => (it.key === key ? { ...it, ...patch } : it))); setErrors({}); };
  const totals = items.map(preview).reduce((a, p) => ({ gross: a.gross + p.gross, discount: a.discount + p.discount, tax: a.tax + p.tax, total: a.total + p.total }), { gross: 0, discount: 0, tax: 0, total: 0 });
  const rateOptions = [...new Set(['0', ...(taxRates.data ?? []).filter((t) => t.isActive).map((t) => String(Number(t.rate))), ...items.map((i) => String(Number(i.taxRate) || 0))])].sort((a, b) => Number(a) - Number(b));
  const showTax = Boolean(s?.taxEnabled) || rateOptions.length > 1;

  const save = (issue: boolean) => {
    const body = { ...head, issue, items: items.map(({ key: _key, ...it }) => it) };
    void run((idem) => (editing ? api.patch<{ id: string }>(`/invoices/${id}`, body).then(async (r) => { if (issue) await api.post(`/invoices/${id}/issue`); return r; }) : api.post<{ id: string }>('/invoices', body, idem)), {
      success: issue ? 'Invoice issued' : 'Draft saved', setErrors,
      onDone: (r) => navigate(`/invoices/${r.data.id}`, { replace: true }),
    });
  };
  const onSubmit = (e: FormEvent) => { e.preventDefault(); save(false); };

  if (editing && existing.isLoading) return <Loading />;
  if (editing && (existing.isError || !existing.data)) return <Card><ErrorState error={existing.error} onRetry={() => existing.refetch()} /></Card>;
  if (editing && existing.data && existing.data.storedStatus !== 'DRAFT') {
    return <Card className="p-6"><Notice tone="amber" title="This invoice can no longer be edited">Only draft invoices can be changed. To correct an issued invoice, cancel it and create a new one. <Link className="font-semibold underline" to={`/invoices/${id}`}>Back to the invoice</Link></Notice></Card>;
  }
  const itemError = Object.entries(errors).find(([k]) => k.startsWith('items'))?.[1];

  return (
    <form onSubmit={onSubmit} noValidate>
      <Link to={editing ? `/invoices/${id}` : '/invoices'} className="mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> {editing ? 'Back to invoice' : 'Invoices'}</Link>
      <PageHeader title={editing ? `Edit draft ${existing.data?.number ?? ''}` : 'New invoice'} description="Totals shown here are a preview. Final amounts are calculated by the server when you save." />

      <Card className="mb-5 p-5">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Customer" required error={errors.customerId} hint={customers.data && !customers.data.length ? <>No customers yet. <Link className="text-brand-600 underline" to="/customers">Add one first</Link></> : undefined}>
            <Select value={head.customerId} invalid={Boolean(errors.customerId)} onChange={(e) => { setHead({ ...head, customerId: e.target.value }); setErrors({}); }}>
              <option value="">Select a customer</option>{(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.businessName ? ` — ${c.businessName}` : ''}</option>)}
            </Select>
          </Field>
          <Field label="Invoice date" required error={errors.issueDate}><Input type="date" value={head.issueDate} invalid={Boolean(errors.issueDate)} onChange={(e) => setHead({ ...head, issueDate: e.target.value, dueDate: head.dueDate < e.target.value ? e.target.value : head.dueDate })} /></Field>
          <Field label="Due date" required error={errors.dueDate}><Input type="date" min={head.issueDate} value={head.dueDate} invalid={Boolean(errors.dueDate)} onChange={(e) => setHead({ ...head, dueDate: e.target.value })} /></Field>
        </div>
      </Card>

      <Card className="mb-5">
        <div className="table-wrap">
          <table className="table">
            <thead className="bg-slate-50">
              <tr>
                <th className="th min-w-[220px]">Product or service</th><th className="th min-w-[150px]">Income category</th><th className="th w-24 text-right">Quantity</th><th className="th w-32 text-right">Unit price</th>
                <th className="th w-28 text-right">Discount</th>{showTax && <th className="th w-28 text-right">{taxLabel} %</th>}<th className="th w-32 text-right">Amount</th><th className="th w-10" />
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => {
                const p = preview(it);
                return (
                  <tr key={it.key} className="align-top">
                    <td className="td"><Input aria-label={`Line ${i + 1} description`} placeholder="Description" value={it.description} maxLength={300} invalid={Boolean(errors[`items.${i}.description`])} onChange={(e) => setItem(it.key, { description: e.target.value })} /></td>
                    <td className="td"><Select aria-label={`Line ${i + 1} category`} value={it.categoryId} invalid={Boolean(errors[`items.${i}.categoryId`])} onChange={(e) => setItem(it.key, { categoryId: e.target.value })}><option value="">Select</option>{incomeCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></td>
                    <td className="td"><Input aria-label={`Line ${i + 1} quantity`} inputMode="decimal" className="text-right" value={it.quantity} invalid={Boolean(errors[`items.${i}.quantity`])} onChange={(e) => setItem(it.key, { quantity: e.target.value })} /></td>
                    <td className="td"><Input aria-label={`Line ${i + 1} unit price`} inputMode="decimal" className="text-right" placeholder="0.00" value={it.unitPrice} invalid={Boolean(errors[`items.${i}.unitPrice`])} onChange={(e) => setItem(it.key, { unitPrice: e.target.value })} /></td>
                    <td className="td"><Input aria-label={`Line ${i + 1} discount`} inputMode="decimal" className="text-right" placeholder="0.00" value={it.discount} invalid={Boolean(errors[`items.${i}.discount`])} onChange={(e) => setItem(it.key, { discount: e.target.value })} /></td>
                    {showTax && <td className="td"><Select aria-label={`Line ${i + 1} tax rate`} className="text-right" value={String(Number(it.taxRate) || 0)} onChange={(e) => setItem(it.key, { taxRate: e.target.value })}>{rateOptions.map((r) => <option key={r} value={r}>{r}%</option>)}</Select></td>}
                    <td className="td num pt-4 font-medium">{formatMoney(fromPaise(p.net), currency)}</td>
                    <td className="td pt-3"><button type="button" className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-30" disabled={items.length === 1} onClick={() => setItems((list) => list.filter((x) => x.key !== it.key))} aria-label={`Remove line ${i + 1}`}><Trash2 className="h-4 w-4" /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-6 border-t border-slate-100 p-5">
          <div>
            <Button variant="secondary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setItems((list) => [...list, blankItem(incomeCats[0]?.id ?? '')])} disabled={items.length >= 100}>Add line</Button>
            {itemError && <p className="mt-2 text-xs font-medium text-rose-600" role="alert">{itemError}</p>}
            {!showTax && <p className="mt-2 max-w-sm text-xs text-slate-500">Tax is not enabled for this company. An administrator can enable it and add tax rates under Settings.</p>}
          </div>
          <dl className="w-full max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Subtotal</dt><dd className="tabular-nums">{formatMoney(fromPaise(totals.gross), currency)}</dd></div>
            {totals.discount > 0 && <div className="flex justify-between"><dt className="text-slate-500">Discount</dt><dd className="tabular-nums">−{formatMoney(fromPaise(totals.discount), currency)}</dd></div>}
            {showTax && <div className="flex justify-between"><dt className="text-slate-500">{taxLabel}</dt><dd className="tabular-nums">{formatMoney(fromPaise(totals.tax), currency)}</dd></div>}
            <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-slate-900"><dt>Total</dt><dd className="tabular-nums">{formatMoney(fromPaise(totals.total), currency)}</dd></div>
          </dl>
        </div>
      </Card>

      <Card className="mb-5 grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Notes to customer" error={errors.notes}><Textarea rows={3} maxLength={1000} value={head.notes} onChange={(e) => setHead({ ...head, notes: e.target.value })} /></Field>
        <Field label="Terms and conditions" error={errors.terms}><Textarea rows={3} maxLength={2000} value={head.terms} onChange={(e) => setHead({ ...head, terms: e.target.value })} /></Field>
      </Card>

      <div className="flex flex-wrap justify-end gap-2">
        <Link to={editing ? `/invoices/${id}` : '/invoices'}><Button variant="secondary" disabled={busy}>Cancel</Button></Link>
        <Button type="submit" variant="secondary" loading={busy}>Save as draft</Button>
        <Button loading={busy} onClick={() => save(true)} disabled={totals.total <= 0} title={totals.total <= 0 ? 'Add at least one priced line' : undefined}>Save and issue</Button>
      </div>
      <p className="mt-2 text-right text-xs text-slate-500">Issuing posts the invoice to the books and locks it against editing.</p>
    </form>
  );
}
