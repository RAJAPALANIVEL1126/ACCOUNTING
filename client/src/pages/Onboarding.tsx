import { Building2, Clock, LogOut } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useSubmit } from '../lib/hooks';
import { Button, Card, Notice } from '../components/ui';
import { CompanyForm, EMPTY_COMPANY } from '../components/CompanyForm';

/** First run: the setup-created super administrator creates the company. */
export function CompanySetup() {
  const { user, signOut, refresh } = useAuth();
  const { busy, run } = useSubmit();
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-navy-800 text-white"><Building2 className="h-5 w-5" aria-hidden /></div>
            <div>
              <h1 className="text-xl font-semibold text-slate-900">Set up your company</h1>
              <p className="mt-1 text-sm text-slate-500">Welcome, {user?.fullName}. Enter your company details to open the books. Only the company name is required; everything else can be added later.</p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => signOut()} icon={<LogOut className="h-4 w-4" />}>Logout</Button>
        </div>
        <Card className="p-5 sm:p-6">
          <CompanyForm
            initial={EMPTY_COMPANY}
            submitLabel="Create company"
            busy={busy}
            onSubmit={(values, setErrors) => run(() => api.post('/company', values), { success: 'Company created', setErrors, onDone: () => { void refresh(); } })}
          />
        </Card>
        <p className="mt-4 text-xs text-slate-500">A chart of accounts, a cash account and standard income and expense categories are created for you. No transactions are created.</p>
      </div>
    </div>
  );
}

/** A self-registered user whom no administrator has granted company access yet. */
export function AwaitingAccess() {
  const { user, signOut, refresh } = useAuth();
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <Card className="w-full max-w-md p-6 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600"><Clock className="h-6 w-6" aria-hidden /></div>
        <h1 className="text-lg font-semibold text-slate-900">Waiting for access</h1>
        <p className="mt-2 text-sm text-slate-600">Your account <b>{user?.email}</b> is verified but is not attached to a company yet.</p>
        <div className="mt-4 text-left"><Notice>Ask your company administrator to add this email address under <b>User Accounts</b>. You will then see the data your role permits.</Notice></div>
        <div className="mt-5 flex justify-center gap-2">
          <Button variant="secondary" onClick={() => refresh()}>Check again</Button>
          <Button variant="ghost" onClick={() => signOut()} icon={<LogOut className="h-4 w-4" />}>Logout</Button>
        </div>
      </Card>
    </div>
  );
}
