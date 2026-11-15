import { lazy, Suspense } from 'react';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { DateRangeProvider } from './components/DateRangePicker';
import { EmptyState, Loading } from './components/ui';
import { ForgotPassword, ResetPassword, SignIn, SignUp, VerifyEmail } from './pages/Auth';
import { AwaitingAccess, CompanySetup } from './pages/Onboarding';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Company = lazy(() => import('./pages/Company'));
const Transactions = lazy(() => import('./pages/Transactions'));
const Accounts = lazy(() => import('./pages/Accounts'));
const AccountBook = lazy(() => import('./pages/AccountBook'));
const Payments = lazy(() => import('./pages/Payments'));
const Contacts = lazy(() => import('./pages/Contacts'));
const ContactDetail = lazy(() => import('./pages/ContactDetail'));
const Invoices = lazy(() => import('./pages/Invoices'));
const InvoiceForm = lazy(() => import('./pages/InvoiceForm'));
const InvoiceDetail = lazy(() => import('./pages/InvoiceDetail'));
const Reports = lazy(() => import('./pages/Reports'));
const Users = lazy(() => import('./pages/Users'));
const Settings = lazy(() => import('./pages/Settings'));
const AuditLogs = lazy(() => import('./pages/AuditLogs'));

/** Route guard for the UI. The API independently enforces the same permission on every request. */
function Guard({ permission, children }: { permission: string; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(permission)) {
    return <EmptyState icon={<ShieldAlert className="h-5 w-5" />} title="You do not have access to this page" message="Ask an administrator if you need this permission." />;
  }
  return <>{children}</>;
}

function Protected() {
  const { loading, session } = useAuth();
  const location = useLocation();
  if (loading) return <div className="flex min-h-screen items-center justify-center"><Loading label="Loading your workspace…" /></div>;
  if (!session) return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;
  if (!session.company) return session.user.role === 'SUPER_ADMIN' ? <CompanySetup /> : <AwaitingAccess />;
  return (
    <DateRangeProvider>
      <Layout />
    </DateRangeProvider>
  );
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { loading, session } = useAuth();
  if (loading) return <div className="flex min-h-screen items-center justify-center"><Loading /></div>;
  if (session) return <Navigate to="/" replace />;
  return <>{children}</>;
}

const page = (permission: string, node: ReactNode) => (
  <Guard permission={permission}>
    <Suspense fallback={<Loading />}>{node}</Suspense>
  </Guard>
);

export function App() {
  return (
    <Routes>
      <Route path="/signin" element={<PublicOnly><SignIn /></PublicOnly>} />
      <Route path="/signup" element={<PublicOnly><SignUp /></PublicOnly>} />
      <Route path="/forgot-password" element={<PublicOnly><ForgotPassword /></PublicOnly>} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route element={<Protected />}>
        <Route index element={page('reports.view', <Dashboard />)} />
        <Route path="company" element={page('company.view', <Company />)} />
        <Route path="transactions" element={page('transactions.view', <Transactions key="all" mode="all" />)} />
        <Route path="income" element={page('transactions.view', <Transactions key="income" mode="income" />)} />
        <Route path="expenses" element={page('transactions.view', <Transactions key="expense" mode="expense" />)} />
        <Route path="cash" element={page('accounts.view', <Accounts key="cash" kind="CASH" />)} />
        <Route path="bank" element={page('accounts.view', <Accounts key="bank" kind="BANK" />)} />
        <Route path="accounts/:id" element={page('accounts.view', <AccountBook />)} />
        <Route path="payments" element={page('payments.view', <Payments />)} />
        <Route path="customers" element={page('contacts.view', <Contacts key="customers" kind="customers" />)} />
        <Route path="customers/:id" element={page('contacts.view', <ContactDetail key="customer" kind="customers" />)} />
        <Route path="suppliers" element={page('contacts.view', <Contacts key="suppliers" kind="suppliers" />)} />
        <Route path="suppliers/:id" element={page('contacts.view', <ContactDetail key="supplier" kind="suppliers" />)} />
        <Route path="invoices" element={page('invoices.view', <Invoices />)} />
        <Route path="invoices/new" element={page('invoices.manage', <InvoiceForm />)} />
        <Route path="invoices/:id" element={page('invoices.view', <InvoiceDetail />)} />
        <Route path="invoices/:id/edit" element={page('invoices.manage', <InvoiceForm />)} />
        <Route path="reports" element={page('reports.view', <Reports />)} />
        <Route path="reports/:key" element={page('reports.view', <Reports />)} />
        <Route path="users" element={page('users.view', <Users />)} />
        <Route path="settings" element={page('settings.manage', <Settings />)} />
        <Route path="audit-logs" element={page('audit.view', <AuditLogs />)} />
        <Route path="*" element={<EmptyState title="Page not found" message="The page you are looking for does not exist." />} />
      </Route>
    </Routes>
  );
}
