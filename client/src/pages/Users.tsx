import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, KeyRound, Minus, Pencil, Plus } from 'lucide-react';
import { api } from '../lib/api';
import { ROLE_LABELS, useAuth } from '../lib/auth';
import { useForm, useSubmit } from '../lib/hooks';
import { formatDateTime } from '../lib/format';
import { Badge, Button, Card, CardHeader, ConfirmDialog, EmptyState, ErrorState, Field, Input, Loading, Modal, Notice, PageHeader, Select, StatusBadge, Tabs } from '../components/ui';

interface UserRow { id: string; fullName: string; email: string; phone: string | null; role: string; status: 'ACTIVE' | 'INACTIVE'; emailVerified: boolean; lastLoginAt: string | null; createdAt: string }
interface RolesPayload { permissions: Array<{ key: string; description: string }>; roles: Array<{ name: string; description: string; permissions: string[] }> }
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];

function UserFormModal({ open, onClose, user, roles }: { open: boolean; onClose: () => void; user: UserRow | null; roles: string[] }) {
  const { user: me } = useAuth();
  const { busy, run } = useSubmit();
  const initial = () => ({ fullName: user?.fullName ?? '', email: user?.email ?? '', phone: user?.phone ?? '', role: user?.role ?? 'ACCOUNTANT' });
  const f = useForm(initial());
  useEffect(() => { if (open) f.reset(initial()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open, user?.id]);
  const self = user?.id === me?.id;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const { email, role, ...rest } = f.values;
    void run(() => (user ? api.patch(`/users/${user.id}`, { ...rest, ...(self || role === user.role ? {} : { role }) }) : api.post('/users', f.values)), {
      success: user ? 'User updated' : 'User created. A link to set their password has been emailed.', setErrors: f.setErrors, onDone: onClose,
    });
    void email;
  };
  return (
    <Modal open={open} onClose={onClose} title={user ? 'Edit user' : 'Create user account'} description={user ? user.email : 'The user receives an email with a single-use link to choose their own password.'}>
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Full name" required error={f.errors.fullName}><Input autoFocus {...f.bind('fullName')} /></Field>
        {!user && <Field label="Email address" required error={f.errors.email} hint="If this person already registered themselves, they will be granted access with the role below."><Input type="email" {...f.bind('email')} /></Field>}
        <Field label="Phone number" error={f.errors.phone}><Input type="tel" {...f.bind('phone')} /></Field>
        <Field label="Role" required error={f.errors.role} hint={self ? 'You cannot change your own role.' : user && user.role !== f.values.role ? 'Changing the role signs the user out everywhere.' : undefined}>
          <Select {...f.bind('role')} disabled={self}>
            {[...new Set([...(user ? [user.role] : []), ...roles])].map((r) => <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>)}
          </Select>
        </Field>
        <div className="flex justify-end gap-2 pt-1"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>{user ? 'Save changes' : 'Create user'}</Button></div>
      </form>
    </Modal>
  );
}

function ActivityModal({ user, onClose }: { user: UserRow | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['user-activity', user?.id], queryFn: async () => (await api.get<{ activity: Array<{ id: string; action: string; summary: string; createdAt: string; ip: string | null }> }>(`/users/${user!.id}/activity`)).data, enabled: Boolean(user) });
  return (
    <Modal open={Boolean(user)} onClose={onClose} title={`Recent activity — ${user?.fullName ?? ''}`} size="lg">
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.activity.length ? <EmptyState title="No recorded activity" message="Actions this user takes will be listed here." /> : (
        <ol className="space-y-3">
          {q.data.activity.map((a) => (
            <li key={a.id} className="border-b border-slate-100 pb-3 text-sm last:border-0">
              <p className="text-slate-800">{a.summary}</p>
              <p className="mt-0.5 text-xs text-slate-500">{formatDateTime(a.createdAt)} · <span className="font-mono">{a.action}</span>{a.ip ? ` · ${a.ip}` : ''}</p>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

export default function Users() {
  const { can, user: me } = useAuth();
  const canManage = can('users.manage');
  const canManageAdmins = can('admins.manage');
  const users = useQuery({ queryKey: ['users'], queryFn: async () => (await api.get<UserRow[]>('/users')).data });
  const roles = useQuery({ queryKey: ['roles'], queryFn: async () => (await api.get<RolesPayload>('/users/roles')).data, staleTime: Infinity });
  const { run } = useSubmit();
  const [tab, setTab] = useState<'users' | 'roles'>('users');
  const [form, setForm] = useState<{ user: UserRow | null } | null>(null);
  const [activity, setActivity] = useState<UserRow | null>(null);
  const [confirm, setConfirm] = useState<{ user: UserRow; action: 'status' | 'reset' } | null>(null);

  const assignable = (roles.data?.roles ?? []).map((r) => r.name).filter((r) => canManageAdmins || !ADMIN_ROLES.includes(r));
  const editable = (u: UserRow) => canManage && (canManageAdmins || !ADMIN_ROLES.includes(u.role));

  return (
    <>
      <PageHeader title="User Accounts" description="Who can sign in to this company and what they are allowed to do." actions={canManage && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ user: null })}>Create user</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'users', label: 'Users', count: users.data?.length }, { value: 'roles', label: 'Roles and permissions' }]} />

      {tab === 'users' ? (
        <Card>
          {!canManageAdmins && canManage && <div className="border-b border-slate-100 p-4"><Notice>Administrator accounts can only be created or changed by a Super Admin.</Notice></div>}
          {users.isLoading ? <Loading /> : users.isError ? <ErrorState error={users.error} onRetry={() => users.refetch()} /> : (
            <div className="table-wrap">
              <table className="table">
                <thead className="bg-slate-50"><tr><th className="th">Name</th><th className="th">Email</th><th className="th">Phone</th><th className="th">Role</th><th className="th">Status</th><th className="th">Last sign-in</th><th className="th" /></tr></thead>
                <tbody>
                  {(users.data ?? []).map((u) => (
                    <tr key={u.id}>
                      <td className="td font-medium text-slate-900">{u.fullName} {u.id === me?.id && <Badge tone="blue">You</Badge>}</td>
                      <td className="td">{u.email}{!u.emailVerified && <span className="block text-xs text-amber-700">Has not set a password yet</span>}</td>
                      <td className="td whitespace-nowrap">{u.phone ?? '—'}</td>
                      <td className="td"><Badge tone={ADMIN_ROLES.includes(u.role) ? 'violet' : 'slate'}>{ROLE_LABELS[u.role] ?? u.role}</Badge></td>
                      <td className="td"><StatusBadge status={u.status} /></td>
                      <td className="td whitespace-nowrap">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never'}</td>
                      <td className="td whitespace-nowrap text-right">
                        <Button variant="ghost" size="sm" onClick={() => setActivity(u)}>Activity</Button>
                        {editable(u) && (
                          <>
                            <Button variant="ghost" size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setForm({ user: u })}>Edit</Button>
                            {u.id !== me?.id && u.status === 'ACTIVE' && <Button variant="ghost" size="sm" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => setConfirm({ user: u, action: 'reset' })}>Reset password</Button>}
                            {u.id !== me?.id && <Button variant="ghost" size="sm" onClick={() => setConfirm({ user: u, action: 'status' })}>{u.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}</Button>}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : roles.isLoading ? <Loading /> : roles.isError || !roles.data ? <Card><ErrorState error={roles.error} onRetry={() => roles.refetch()} /></Card> : (
        <Card>
          <CardHeader title="Permission matrix" description="Roles are fixed and enforced by the server on every request. Hiding a menu item is never the only protection." />
          <div className="table-wrap">
            <table className="table">
              <thead className="bg-slate-50"><tr><th className="th">Permission</th>{roles.data.roles.map((r) => <th key={r.name} className="th text-center" title={r.description}>{ROLE_LABELS[r.name] ?? r.name}</th>)}</tr></thead>
              <tbody>
                {roles.data.permissions.map((p) => (
                  <tr key={p.key}>
                    <td className="td">{p.description}<span className="block font-mono text-xs text-slate-400">{p.key}</span></td>
                    {roles.data!.roles.map((r) => <td key={r.name} className="td text-center">{r.permissions.includes(p.key) ? <Check className="mx-auto h-4 w-4 text-emerald-600" aria-label="Allowed" /> : <Minus className="mx-auto h-4 w-4 text-slate-300" aria-label="Not allowed" />}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <UserFormModal open={Boolean(form)} onClose={() => setForm(null)} user={form?.user ?? null} roles={assignable} />
      <ActivityModal user={activity} onClose={() => setActivity(null)} />
      <ConfirmDialog
        open={Boolean(confirm)} onClose={() => setConfirm(null)} danger={confirm?.action === 'status' && confirm.user.status === 'ACTIVE'}
        title={confirm?.action === 'reset' ? `Send a password reset link to ${confirm.user.fullName}?` : `${confirm?.user.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} ${confirm?.user.fullName ?? ''}?`}
        confirmLabel={confirm?.action === 'reset' ? 'Send reset link' : confirm?.user.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
        message={confirm?.action === 'reset' ? `A single-use link will be emailed to ${confirm.user.email} and they will be signed out everywhere. You never see or set their password.` : confirm?.user.status === 'ACTIVE' ? 'They will be signed out immediately and will not be able to sign in. Their past records are kept.' : 'They will be able to sign in again with their existing password.'}
        onConfirm={async () => {
          const c = confirm!;
          const r = await run(() => (c.action === 'reset' ? api.post(`/users/${c.user.id}/reset-password`) : api.patch(`/users/${c.user.id}/status`, { status: c.user.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })), { success: c.action === 'reset' ? 'Password reset link sent' : 'User status updated' });
          if (r === undefined) throw new Error('The action could not be completed.');
        }}
      />
    </>
  );
}
