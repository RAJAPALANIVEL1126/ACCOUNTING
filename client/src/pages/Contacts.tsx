import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Plus, Search, Truck, Users } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useDebounced, useForm, useSubmit } from '../lib/hooks';
import type { Party } from '../lib/hooks';
import { Badge, Button, Card, Checkbox, cn, EmptyState, ErrorState, Field, Input, Loading, Modal, Money, PageHeader, Pagination, Textarea } from '../components/ui';

export const PARTY_COPY = {
  customers: { title: 'Customers', singular: 'customer', balance: 'Receivable', opening: 'Opening receivable balance', description: 'People and businesses you sell to, with what they currently owe you.', icon: Users },
  suppliers: { title: 'Suppliers', singular: 'supplier', balance: 'Payable', opening: 'Opening payable balance', description: 'People and businesses you buy from, with what you currently owe them.', icon: Truck },
};

export function PartyFormModal({ kind, open, onClose, party }: { kind: 'customers' | 'suppliers'; open: boolean; onClose: () => void; party?: Party | null }) {
  const copy = PARTY_COPY[kind];
  const { currency } = useAuth();
  const { busy, run } = useSubmit();
  const initial = () => ({ name: party?.name ?? '', businessName: party?.businessName ?? '', email: party?.email ?? '', phone: party?.phone ?? '', address: party?.address ?? '', gstin: party?.gstin ?? '', openingBalance: '', isActive: party?.isActive ?? true });
  const f = useForm(initial());
  useEffect(() => { if (open) f.reset(initial()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, party?.id]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { openingBalance, isActive, ...rest } = f.values;
    void run((key) => (party ? api.patch(`/${kind}/${party.id}`, { ...rest, isActive }) : api.post(`/${kind}`, { ...rest, openingBalance }, key)), {
      success: party ? `${copy.title.slice(0, -1)} updated` : `${copy.title.slice(0, -1)} created`, setErrors: f.setErrors, onDone: onClose,
    });
  };
  return (
    <Modal open={open} onClose={onClose} title={party ? `Edit ${copy.singular}` : `New ${copy.singular}`}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required error={f.errors.name}><Input autoFocus {...f.bind('name')} maxLength={120} /></Field>
          <Field label="Business name" error={f.errors.businessName}><Input {...f.bind('businessName')} maxLength={160} /></Field>
          <Field label="Email" error={f.errors.email}><Input type="email" {...f.bind('email')} /></Field>
          <Field label="Phone" error={f.errors.phone}><Input type="tel" {...f.bind('phone')} /></Field>
          <Field label="Address" error={f.errors.address} className="sm:col-span-2"><Textarea rows={2} {...f.bind('address')} maxLength={400} /></Field>
          <Field label="GSTIN" error={f.errors.gstin} hint="Only if registered for GST"><Input className="uppercase" {...f.bind('gstin')} maxLength={15} /></Field>
          {!party && <Field label={`${copy.opening} (${currency})`} error={f.errors.openingBalance} hint="Amount already outstanding today, if any"><Input inputMode="decimal" placeholder="0.00" {...f.bind('openingBalance')} /></Field>}
        </div>
        {party && <Checkbox label="Active" hint="Inactive records are hidden from selection lists but keep their history." checked={f.values.isActive} onChange={(v) => f.set('isActive', v)} />}
        <div className="flex justify-end gap-2 pt-1"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>{party ? 'Save changes' : `Create ${copy.singular}`}</Button></div>
      </form>
    </Modal>
  );
}

export default function Contacts({ kind }: { kind: 'customers' | 'suppliers' }) {
  const copy = PARTY_COPY[kind];
  const { can } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim());
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  useEffect(() => { setPage(1); }, [q, includeInactive]);
  const query = { q, page, pageSize: 25, includeInactive: includeInactive ? 1 : undefined };
  const list = useQuery({ queryKey: [kind, query], queryFn: () => api.get<Party[], { page: number; pageSize: number; total: number; totalOutstanding: string }>(`/${kind}`, query), placeholderData: keepPreviousData });
  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const Icon = copy.icon;

  return (
    <>
      <PageHeader title={copy.title} description={copy.description} actions={can('contacts.manage') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New {copy.singular}</Button>} />
      <Card>
        <div className="no-print flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="relative w-72 max-w-full">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <Input aria-label={`Search ${copy.title.toLowerCase()}`} placeholder="Search name, business, email, phone…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <Checkbox label="Show inactive" checked={includeInactive} onChange={setIncludeInactive} />
          </div>
          {meta && <p className="text-sm text-slate-600">Total outstanding {copy.balance.toLowerCase()}s: <Money value={meta.totalOutstanding} className="font-semibold text-slate-900" /></p>}
        </div>
        {list.isLoading ? <Loading /> : list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : rows.length === 0 ? (
          <EmptyState icon={<Icon className="h-5 w-5" />} title={q ? `No ${copy.title.toLowerCase()} match "${q}"` : `No ${copy.title.toLowerCase()} yet`} message={q ? 'Check the spelling or try a different search.' : `Add your first ${copy.singular} to link invoices, payments and balances.`}
            action={!q && can('contacts.manage') ? <Button icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>New {copy.singular}</Button> : undefined} />
        ) : (
          <div className={cn('table-wrap', list.isPlaceholderData && 'opacity-60')}>
            <table className="table">
              <thead className="bg-slate-50"><tr><th className="th">Name</th><th className="th">Business name</th><th className="th">Email</th><th className="th">Phone</th><th className="th">GSTIN</th><th className="th num">Outstanding {copy.balance.toLowerCase()}</th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className="row-click" tabIndex={0} onClick={() => navigate(`/${kind}/${p.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/${kind}/${p.id}`)}>
                    <td className="td font-medium text-slate-900">{p.name} {!p.isActive && <Badge>Inactive</Badge>}</td>
                    <td className="td">{p.businessName ?? '—'}</td>
                    <td className="td">{p.email ?? '—'}</td>
                    <td className="td whitespace-nowrap">{p.phone ?? '—'}</td>
                    <td className="td font-mono text-xs">{p.gstin ?? '—'}</td>
                    <td className="td num font-medium"><Money value={p.outstanding} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {meta && <Pagination page={meta.page} pageSize={meta.pageSize} total={meta.total} onPage={setPage} />}
      </Card>
      <PartyFormModal kind={kind} open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
