import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, CheckCircle2, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useForm } from '../lib/hooks';
import { Button, Field, Input, Notice } from '../components/ui';

export function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <div className="relative hidden w-[44%] flex-col justify-between bg-navy-900 p-10 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-600"><BarChart3 className="h-5 w-5" aria-hidden /></div>
          <span className="text-lg font-semibold">Company Accounting</span>
        </div>
        <div>
          <h2 className="max-w-sm text-3xl font-semibold leading-tight text-white">Clear books. Confident decisions.</h2>
          <ul className="mt-6 space-y-3 text-sm text-slate-300">
            {['Income, expenses, cash and bank in one ledger', 'Invoices, receivables and payables that reconcile', 'Daily, monthly and profit & loss reports with exports'].map((t) => (
              <li key={t} className="flex items-start gap-2.5"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-500" aria-hidden />{t}</li>
            ))}
          </ul>
        </div>
        <p className="flex items-center gap-2 text-xs text-slate-400"><ShieldCheck className="h-4 w-4" aria-hidden /> Role-based access · Audit trail · Encrypted sessions</p>
      </div>
      <div className="flex flex-1 items-center justify-center px-5 py-10">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-600 text-white"><BarChart3 className="h-5 w-5" aria-hidden /></div>
            <span className="text-lg font-semibold text-slate-900">Company Accounting</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>}
          <div className="mt-6">{children}</div>
          {footer && <div className="mt-6 text-sm text-slate-600">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

const linkCls = 'font-medium text-brand-600 hover:text-brand-700 hover:underline';

export function SignIn() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const f = useForm({ email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [resent, setResent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null); setResent(false);
    try {
      await signIn(f.values.email.trim(), f.values.password);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from.startsWith('/') && !from.startsWith('//') ? from : '/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) { setError(err); f.setErrors(err.fields); } else setError(new ApiError(0, 'ERROR', 'Something went wrong'));
    } finally { setBusy(false); }
  };
  const resend = async () => {
    try { await api.post('/auth/resend-verification', { email: f.values.email.trim() }); setResent(true); } catch { /* generic by design */ }
  };

  return (
    <AuthShell title="Sign in" subtitle="Enter your credentials to open your company books." footer={<>New here? <Link className={linkCls} to="/signup">Create an account</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && !Object.keys(error.fields).length && (
          <Notice tone="red">
            {error.message}
            {error.code === 'EMAIL_NOT_VERIFIED' && <> <button type="button" className="font-semibold underline" onClick={resend}>Resend verification email</button></>}
          </Notice>
        )}
        {resent && <Notice tone="green">If the account exists and is unverified, a new link is on its way.</Notice>}
        <Field label="Email address" required error={f.errors.email}><Input type="email" autoComplete="username" autoFocus required {...f.bind('email')} /></Field>
        <Field label="Password" required error={f.errors.password}><Input type="password" autoComplete="current-password" required {...f.bind('password')} /></Field>
        <div className="flex justify-end"><Link className={`text-sm ${linkCls}`} to="/forgot-password">Forgot password?</Link></div>
        <Button type="submit" className="w-full" loading={busy}>Sign in</Button>
      </form>
    </AuthShell>
  );
}

export function SignUp() {
  const f = useForm({ fullName: '', email: '', phone: '', password: '', confirmPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.values.password !== f.values.confirmPassword) return f.setErrors({ confirmPassword: 'Passwords do not match' });
    setBusy(true); setError('');
    try { await api.post('/auth/signup', f.values); setDone(true); }
    catch (err) { if (err instanceof ApiError) { f.setErrors(err.fields); if (!Object.keys(err.fields).length) setError(err.message); } else setError('Something went wrong'); }
    finally { setBusy(false); }
  };

  if (done) {
    return (
      <AuthShell title="Check your inbox" footer={<Link className={linkCls} to="/signin">Back to sign in</Link>}>
        <Notice tone="green" title="Almost there">We sent a verification link to <b>{f.values.email}</b>. Open it to activate your account.</Notice>
        <p className="mt-4 text-sm text-slate-600">New accounts start with no company access. After you verify your email, a company administrator must grant you access before you can see any financial data.</p>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Create your account" subtitle="An administrator will grant you access to your company after you verify your email." footer={<>Already registered? <Link className={linkCls} to="/signin">Sign in</Link></>}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Notice tone="red">{error}</Notice>}
        <Field label="Full name" required error={f.errors.fullName}><Input autoComplete="name" autoFocus required {...f.bind('fullName')} /></Field>
        <Field label="Email address" required error={f.errors.email}><Input type="email" autoComplete="email" required {...f.bind('email')} /></Field>
        <Field label="Phone number" required error={f.errors.phone}><Input type="tel" autoComplete="tel" placeholder="+91 98765 43210" required {...f.bind('phone')} /></Field>
        <Field label="Password" required error={f.errors.password} hint="At least 10 characters, with a letter and a number."><Input type="password" autoComplete="new-password" required {...f.bind('password')} /></Field>
        <Field label="Confirm password" required error={f.errors.confirmPassword}><Input type="password" autoComplete="new-password" required {...f.bind('confirmPassword')} /></Field>
        <Button type="submit" className="w-full" loading={busy}>Create account</Button>
      </form>
    </AuthShell>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { const { data } = await api.post<{ message: string }>('/auth/forgot-password', { email: email.trim() }); setMessage(data.message); }
    catch (err) { setError(err instanceof ApiError ? err.fields.email ?? err.message : 'Something went wrong'); }
    finally { setBusy(false); }
  };
  return (
    <AuthShell title="Reset your password" subtitle="Enter your email and we will send you a link to choose a new password." footer={<Link className={linkCls} to="/signin">Back to sign in</Link>}>
      {message ? <Notice tone="green">{message}</Notice> : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <Field label="Email address" required error={error}><Input type="email" autoComplete="email" autoFocus required value={email} invalid={Boolean(error)} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button type="submit" className="w-full" loading={busy}>Send reset link</Button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const { signOut, session } = useAuth();
  const f = useForm({ password: '', confirmPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.values.password !== f.values.confirmPassword) return f.setErrors({ confirmPassword: 'Passwords do not match' });
    setBusy(true); setError('');
    try {
      await api.post('/auth/reset-password', { token, ...f.values });
      if (session) await signOut();
      setDone(true);
    } catch (err) { if (err instanceof ApiError) { f.setErrors(err.fields); if (!Object.keys(err.fields).length) setError(err.message); } else setError('Something went wrong'); }
    finally { setBusy(false); }
  };

  if (!token) return <AuthShell title="Invalid link" footer={<Link className={linkCls} to="/forgot-password">Request a new link</Link>}><Notice tone="red">This password link is missing its token.</Notice></AuthShell>;
  if (done) return <AuthShell title="Password updated" footer={<Link className={linkCls} to="/signin">Continue to sign in</Link>}><Notice tone="green">Your password has been changed and all other sessions were signed out.</Notice></AuthShell>;
  return (
    <AuthShell title="Choose a new password" subtitle="Use a password you do not use anywhere else.">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error && <Notice tone="red">{error} <Link className="font-semibold underline" to="/forgot-password">Request a new link</Link></Notice>}
        <Field label="New password" required error={f.errors.password} hint="At least 10 characters, with a letter and a number."><Input type="password" autoComplete="new-password" autoFocus required {...f.bind('password')} /></Field>
        <Field label="Confirm new password" required error={f.errors.confirmPassword}><Input type="password" autoComplete="new-password" required {...f.bind('confirmPassword')} /></Field>
        <Button type="submit" className="w-full" loading={busy}>Update password</Button>
      </form>
    </AuthShell>
  );
}

export function VerifyEmail() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'working' | 'ok' | 'failed'>('working');
  const [message, setMessage] = useState('');
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // the token is single-use: never send it twice (React StrictMode double-invokes effects)
    started.current = true;
    if (!token) { setState('failed'); setMessage('This verification link is missing its token.'); return; }
    api.post<{ message: string }>('/auth/verify-email', { token })
      .then(({ data }) => { setMessage(data.message); setState('ok'); })
      .catch((e) => { setMessage(e instanceof ApiError ? e.message : 'Verification failed'); setState('failed'); });
  }, [token]);
  return (
    <AuthShell title="Email verification" footer={<Link className={linkCls} to="/signin">Go to sign in</Link>}>
      {state === 'working' ? <Notice>Verifying your email address…</Notice> : <Notice tone={state === 'ok' ? 'green' : 'red'}>{message}</Notice>}
    </AuthShell>
  );
}
