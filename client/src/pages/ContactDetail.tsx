import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, FilePlus2, Pencil } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Party } from '../lib/hooks';
import { formatDate } from '../lib/format';
import { todayIso } from '../lib/dates';
import { Badge, Button, Card, CardHeader, DescriptionList, EmptyState, ErrorState, Loading, Money, PageHeader } from '../components/ui';
import { PARTY_COPY, PartyFormModal } from './Contacts';
import { SettleDialog } from '../components/PaymentDialogs';
import { TransactionDetailModal } from '../components/TransactionDetail';

interface Detail extends Party {
  openDocuments: Array<{ id: string; number: string; date: string; dueDate: string | null; total: string; paid: string; outstanding: string }>;
  ledger: Array<{ date: string; doc: string | null; transactionId: string | null; invoiceId: string | null; description: string | null; amount: string; balance: string }>;
}

export default function ContactDetail({ kind }: { kind: 'customers' | 'suppliers' }) {
  const { id = '' } = useParams();
  const copy = PARTY_COPY[kind];
  const isCustomer = kind === 'customers';
  const { can } = useAuth();
  const q = useQuery({ queryKey: [kind, 'detail', id], queryFn: async () => (await api.get<Detail>(`/${kind}/${id}`)).data });
  const [editing, setEditing] = useState(false);
  const [settle, setSettle] = useState<Detail['openDocuments'][number] | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;
  const p = q.data;
  const today = todayIso();

  return (
    <>
      <Link to={`/${kind}`} className="no-print mb-3 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> {copy.title}</Link>
      <PageHeader
        title={p.name}
        description={<>{p.businessName ?? (isCustomer ? 'Customer' : 'Supplier')} {!p.isActive && <Badge>Inactive</Badge>}</>}
        actions={
          <>
            {isCustomer && can('invoices.manage') && <Link to={`/invoices/new?customerId=${p.id}`}><Button variant="secondary" icon={<FilePlus2 className="h-4 w-4" />}>New invoice</Button></Link>}
            {can('contacts.manage') && <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => setEditing(true)}>Edit</Button>}
          </>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <Card>
            <CardHeader title={isCustomer ? 'Open invoices' : 'Unpaid bills'} description={isCustomer ? 'Issued invoices that are not fully paid' : 'Expenses recorded on credit that are not fully paid'} />
            {p.openDocuments.length === 0 ? <EmptyState title={isCustomer ? 'No open invoices' : 'No unpaid bills'} message="Nothing is outstanding on individual documents." /> : (
              <div className="table-wrap">
                <table className="table">
                  <thead className="bg-slate-50"><tr><th className="th">Document</th><th className="th">Date</th><th className="th">Due</th><th className="th num">Total</th><th className="th num">Paid</th><th className="th num">Outstanding</th><th className="th" /></tr></thead>
                  <tbody>
                    {p.openDocuments.map((d) => (
                      <tr key={d.id}>
                        <td className="td font-medium">{isCustomer ? <Link className="text-brand-600 hover:underline" to={`/invoices/${d.id}`}>{d.number}</Link> : <button className="text-brand-600 hover:underline" onClick={() => setDetail(d.id)}>{d.number}</button>}</td>
                        <td className="td whitespace-nowrap">{formatDate(d.date)}</td>
                        <td className="td whitespace-nowrap">{d.dueDate ? <span className={d.dueDate < today ? 'font-medium text-rose-700' : ''}>{formatDate(d.dueDate)}{d.dueDate < today ? ' · overdue' : ''}</span> : '—'}</td>
                        <td className="td num"><Money value={d.total} /></td>
                        <td className="td num"><Money value={d.paid} /></td>
                        <td className="td num font-medium"><Money value={d.outstanding} /></td>
                        <td className="td text-right">{can('payments.manage') && <Button variant="secondary" size="sm" onClick={() => setSettle(d)}>{isCustomer ? 'Record payment' : 'Pay'}</Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card>
            <CardHeader title="Transaction history" description={`Every posting to the ${isCustomer ? 'receivable' : 'payable'} ledger for this ${copy.singular}, newest first`} />
            {p.ledger.length === 0 ? <EmptyState title="No history yet" message={isCustomer ? 'Invoices, receipts and refunds will appear here.' : 'Bills and payments will appear here.'} /> : (
              <div className="table-wrap">
                <table className="table">
                  <thead className="bg-slate-50"><tr><th className="th">Date</th><th className="th">Document</th><th className="th">Description</th><th className="th num">{isCustomer ? 'Charged' : 'Billed'}</th><th className="th num">{isCustomer ? 'Received' : 'Paid'}</th><th className="th num">Balance</th></tr></thead>
                  <tbody>
                    {p.ledger.map((l, i) => (
                      <tr key={i}>
                        <td className="td whitespace-nowrap">{formatDate(l.date)}</td>
                        <td className="td whitespace-nowrap font-medium">
                          {l.invoiceId ? <Link className="text-brand-600 hover:underline" to={`/invoices/${l.invoiceId}`}>{l.doc}</Link> : l.transactionId ? <button className="text-brand-600 hover:underline" onClick={() => setDetail(l.transactionId)}>{l.doc}</button> : l.doc}
                        </td>
                        <td className="td">{l.description ?? '—'}</td>
                        <td className="td num">{Number(l.amount) > 0 ? <Money value={l.amount} /> : ''}</td>
                        <td className="td num">{Number(l.amount) < 0 ? <Money value={(-Number(l.amount)).toFixed(2)} /> : ''}</td>
                        <td className="td num font-medium"><Money value={l.balance} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
        <div className="space-y-5">
          <Card className="p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Outstanding {copy.balance.toLowerCase()}</p>
            <Money value={p.outstanding} className="mt-1 block text-2xl font-semibold text-slate-900" />
            <p className="mt-1 text-xs text-slate-500">{Number(p.outstanding) < 0 ? (isCustomer ? 'Credit balance: the customer has paid in advance.' : 'You have paid this supplier in advance.') : isCustomer ? 'Amount this customer owes you.' : 'Amount you owe this supplier.'}</p>
          </Card>
          <Card className="p-5">
            <DescriptionList items={[['Email', p.email], ['Phone', p.phone], ['GSTIN', p.gstin], ['Address', p.address], [copy.opening, <Money key="o" value={p.openingBalance} />]]} />
          </Card>
        </div>
      </div>
      <PartyFormModal kind={kind} open={editing} onClose={() => setEditing(false)} party={p} />
      <SettleDialog open={Boolean(settle)} onClose={() => setSettle(null)} target={settle ? { kind: isCustomer ? 'invoice' : 'bill', id: settle.id, number: settle.number, outstanding: settle.outstanding, party: p.name } : null} />
      <TransactionDetailModal id={detail} onClose={() => setDetail(null)} onOpen={setDetail} />
    </>
  );
}
