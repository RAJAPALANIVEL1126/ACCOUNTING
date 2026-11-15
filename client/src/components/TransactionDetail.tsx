import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, Download, Pencil, RotateCcw, X as XIcon } from 'lucide-react';
import { api, download, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSubmit } from '../lib/hooks';
import { useToast } from '../lib/toast';
import { fileSize, formatDate, formatDateTime, methodLabel, typeLabel } from '../lib/format';
import { Button, ConfirmDialog, DescriptionList, ErrorState, Field, Input, Loading, Modal, Money, Notice, StatusBadge, Textarea } from './ui';

interface Detail {
  id: string; number: string; companyId: string; type: string; status: string; date: string; amount: string; taxAmount: string; totalAmount: string; taxRecoverable: boolean; currency: string;
  category: { id: string; name: string } | null; paymentMethod: string; sourceAccount: { id: string; name: string } | null; destinationAccount: { id: string; name: string } | null;
  customer: { id: string; name: string } | null; supplier: { id: string; name: string } | null; invoice: { id: string; number: string } | null;
  reference: string | null; description: string | null; reason: string | null; onCredit: boolean; amountPaid: string; outstanding: string; dueDate: string | null;
  isReversal: boolean; reversalOf: { id: string; number: string } | null; reversedBy: { id: string; number: string; date: string; reason: string | null } | null;
  approval: { status: string; approvedBy: string | null; approvedAt: string | null; rejectionReason: string | null } | null;
  attachment: { id: string; fileName: string; mimeType: string; size: number } | null; createdBy: string | null; createdById: string; createdAt: string; updatedAt: string;
  journal: Array<{ id: string; number: string; date: string; description: string | null; isReversal: boolean; lines: Array<{ account: string; category: string | null; debit: string; credit: string }> }>;
  history: Array<{ id: string; action: string; summary: string; userName: string | null; createdAt: string }>;
}

export function TransactionDetailModal({ id, onClose, onOpen }: { id: string | null; onClose: () => void; onOpen?: (id: string) => void }) {
  const { can, user } = useAuth();
  const toast = useToast();
  const q = useQuery({ queryKey: ['transaction', id], queryFn: async () => (await api.get<Detail>(`/transactions/${id}`)).data, enabled: Boolean(id) });
  const { busy, run } = useSubmit();
  const [confirm, setConfirm] = useState<'reverse' | 'reject' | 'approve' | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ description: '', reference: '' });
  const t = q.data;

  const act = async (path: string, body: unknown, success: string) => {
    const r = await run(() => api.post(`/transactions/${id}/${path}`, body), { success });
    if (r === undefined) throw new Error('The action could not be completed');
  };
  const pending = t?.status === 'PENDING_APPROVAL';
  const canReverse = t && t.status === 'POSTED' && !t.isReversal && t.type !== 'REFUND' && can('transactions.reverse');
  const canEdit = t && !t.isReversal && (t.status === 'POSTED' || pending) && can('transactions.create');

  return (
    <Modal open={Boolean(id)} onClose={onClose} title={t ? `${typeLabel(t.type)} ${t.number}` : 'Transaction'} size="lg">
      {q.isLoading ? <Loading /> : q.isError || !t ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={t.isReversal ? 'REVERSAL' : t.status} />
              {t.approval && t.approval.status !== 'NOT_REQUIRED' && <span className="text-xs text-slate-500">Approval: <StatusBadge status={t.approval.status} /></span>}
            </div>
            <Money value={t.totalAmount} className="text-2xl font-semibold text-slate-900" />
          </div>

          {t.reversedBy && <Notice tone="amber">Reversed on {formatDate(t.reversedBy.date)} by <button className="font-semibold underline" onClick={() => onOpen?.(t.reversedBy!.id)}>{t.reversedBy.number}</button>{t.reversedBy.reason ? ` — ${t.reversedBy.reason}` : ''}. The original entry is kept for the record.</Notice>}
          {t.reversalOf && <Notice>This entry reverses <button className="font-semibold underline" onClick={() => onOpen?.(t.reversalOf!.id)}>{t.reversalOf.number}</button>{t.reason ? ` — ${t.reason}` : ''}.</Notice>}
          {pending && <Notice tone="amber">Awaiting approval. This expense has not been posted and does not affect balances or reports yet.</Notice>}
          {t.status === 'REJECTED' && <Notice tone="red">Rejected{t.approval?.approvedBy ? ` by ${t.approval.approvedBy}` : ''}: {t.approval?.rejectionReason ?? t.reason}</Notice>}

          {editing ? (
            <div className="grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-2">
              <Field label="Reference number"><Input value={draft.reference} maxLength={100} onChange={(e) => setDraft({ ...draft, reference: e.target.value })} /></Field>
              <Field label="Description" className="sm:col-span-2"><Textarea value={draft.description} maxLength={500} rows={2} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></Field>
              <div className="flex justify-end gap-2 sm:col-span-2">
                <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
                <Button size="sm" loading={busy} onClick={() => run(() => api.patch(`/transactions/${t.id}`, draft), { success: 'Transaction updated', onDone: () => setEditing(false) })}>Save</Button>
              </div>
              <p className="text-xs text-slate-500 sm:col-span-2">Amounts, dates, accounts and categories of posted transactions cannot be edited. Reverse the transaction and record a new one instead.</p>
            </div>
          ) : (
            <DescriptionList items={[
              ['Date', formatDate(t.date)],
              ['Category', t.category?.name],
              ['Amount', <Money key="a" value={t.amount} />],
              ['Tax', Number(t.taxAmount) > 0 ? <><Money value={t.taxAmount} /> {t.type === 'EXPENSE' && <span className="text-xs text-slate-500">({t.taxRecoverable ? 'recoverable' : 'included in cost'})</span>}</> : null],
              ['Payment method', methodLabel(t.paymentMethod)],
              ['Source account', t.sourceAccount?.name],
              ['Destination account', t.destinationAccount?.name],
              ['Customer', t.customer ? <Link className="text-brand-600 hover:underline" to={`/customers/${t.customer.id}`} onClick={onClose}>{t.customer.name}</Link> : null],
              ['Supplier', t.supplier ? <Link className="text-brand-600 hover:underline" to={`/suppliers/${t.supplier.id}`} onClick={onClose}>{t.supplier.name}</Link> : null],
              ['Invoice', t.invoice ? <Link className="text-brand-600 hover:underline" to={`/invoices/${t.invoice.id}`} onClick={onClose}>{t.invoice.number}</Link> : null],
              ['Reference', t.reference],
              ['Outstanding', t.onCredit ? <><Money value={t.outstanding} /> <span className="text-xs text-slate-500">of {t.totalAmount} · due {formatDate(t.dueDate)}</span></> : null],
              ['Description', t.description],
              ['Reason', !t.isReversal && t.status !== 'REJECTED' ? t.reason : null],
              ['Created by', t.createdBy],
              ['Created', formatDateTime(t.createdAt)],
              ['Last updated', t.updatedAt !== t.createdAt ? formatDateTime(t.updatedAt) : null],
              ['Approved by', t.approval?.status === 'APPROVED' ? `${t.approval.approvedBy ?? '—'} · ${formatDateTime(t.approval.approvedAt)}` : null],
              ['Currency', t.currency],
            ]} />
          )}

          {t.attachment && (
            <div className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <span className="truncate">{t.attachment.fileName} <span className="text-xs text-slate-500">· {fileSize(t.attachment.size)}</span></span>
              <Button variant="ghost" size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={() => download(`/attachments/${t.attachment!.id}/file`, undefined, t.attachment!.fileName).catch((e) => toast.error(errorMessage(e)))}>Download</Button>
            </div>
          )}

          {t.journal.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Accounting entry</h3>
              {t.journal.map((j) => (
                <div key={j.id} className="table-wrap mb-2 rounded-md border border-slate-200">
                  <table className="table">
                    <thead className="bg-slate-50"><tr><th className="th">{j.number} · {formatDate(j.date)}</th><th className="th num">Debit</th><th className="th num">Credit</th></tr></thead>
                    <tbody>
                      {j.lines.map((l, i) => (
                        <tr key={i}>
                          <td className="td">{l.account}{l.category && <span className="text-slate-500"> — {l.category}</span>}</td>
                          <td className="td num">{Number(l.debit) ? <Money value={l.debit} /> : ''}</td>
                          <td className="td num">{Number(l.credit) ? <Money value={l.credit} /> : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}

          {t.history.length > 0 && (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">History</h3>
              <ol className="space-y-2 border-l border-slate-200 pl-4">
                {t.history.map((h) => (
                  <li key={h.id} className="relative text-sm">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-slate-300" aria-hidden />
                    <p className="text-slate-700">{h.summary}</p>
                    <p className="text-xs text-slate-500">{h.userName ?? 'System'} · {formatDateTime(h.createdAt)}</p>
                  </li>
                ))}
              </ol>
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4">
            {canEdit && !editing && <Button variant="secondary" icon={<Pencil className="h-4 w-4" />} onClick={() => { setDraft({ description: t.description ?? '', reference: t.reference ?? '' }); setEditing(true); }}>Edit details</Button>}
            {pending && can('expenses.approve') && (
              <>
                <Button variant="danger" icon={<XIcon className="h-4 w-4" />} onClick={() => setConfirm('reject')}>Reject</Button>
                <Button variant="success" icon={<Check className="h-4 w-4" />} onClick={() => setConfirm('approve')} title={t.createdById === user?.id ? 'Company policy may require an independent approver' : undefined}>Approve and post</Button>
              </>
            )}
            {canReverse && <Button variant="danger" icon={<RotateCcw className="h-4 w-4" />} onClick={() => setConfirm('reverse')}>Reverse transaction</Button>}
          </div>

          <ConfirmDialog open={confirm === 'reverse'} onClose={() => setConfirm(null)} danger title={`Reverse ${t.number}?`} confirmLabel="Reverse transaction" reasonLabel="Reason for reversal"
            message="A reversing entry dated today will be posted and both entries are kept permanently. This cannot be undone."
            onConfirm={(reason) => act('reverse', { reason }, `${t.number} reversed`)} />
          <ConfirmDialog open={confirm === 'reject'} onClose={() => setConfirm(null)} danger title={`Reject ${t.number}?`} confirmLabel="Reject expense" reasonLabel="Reason for rejection"
            message="The expense will be marked rejected and will never be posted." onConfirm={(reason) => act('reject', { reason }, `${t.number} rejected`)} />
          <ConfirmDialog open={confirm === 'approve'} onClose={() => setConfirm(null)} title={`Approve ${t.number}?`} confirmLabel="Approve and post"
            message={<>The expense of <Money value={t.totalAmount} /> will be posted to the books on its recorded date ({formatDate(t.date)}).</>} onConfirm={() => act('approve', {}, `${t.number} approved and posted`)} />
        </div>
      )}
    </Modal>
  );
}
