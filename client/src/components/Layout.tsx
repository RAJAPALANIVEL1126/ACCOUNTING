import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  ArrowLeftRight, Banknote, Building2, ChevronsLeft, ChevronsRight, CreditCard, FileBarChart, FileText, Landmark, LayoutDashboard, LogOut, Menu,
  ScrollText, Settings, TrendingDown, TrendingUp, Truck, UserCog, Users, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ROLE_LABELS, useAuth } from '../lib/auth';
import { cn } from './ui';

interface NavItem { to: string; label: string; icon: LucideIcon; permission: string; end?: boolean }

// Items the user has no permission for are hidden here — and refused by the API regardless.
const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, permission: 'reports.view', end: true },
  { to: '/company', label: 'Company Details', icon: Building2, permission: 'company.view' },
  { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight, permission: 'transactions.view' },
  { to: '/income', label: 'Income', icon: TrendingUp, permission: 'transactions.view' },
  { to: '/expenses', label: 'Expenses', icon: TrendingDown, permission: 'transactions.view' },
  { to: '/cash', label: 'Cash Management', icon: Banknote, permission: 'accounts.view' },
  { to: '/bank', label: 'Bank Accounts', icon: Landmark, permission: 'accounts.view' },
  { to: '/payments', label: 'Online Payments', icon: CreditCard, permission: 'payments.view' },
  { to: '/customers', label: 'Customers', icon: Users, permission: 'contacts.view' },
  { to: '/suppliers', label: 'Suppliers', icon: Truck, permission: 'contacts.view' },
  { to: '/invoices', label: 'Invoices', icon: FileText, permission: 'invoices.view' },
  { to: '/reports', label: 'Reports', icon: FileBarChart, permission: 'reports.view' },
  { to: '/users', label: 'User Accounts', icon: UserCog, permission: 'users.view' },
  { to: '/settings', label: 'Settings', icon: Settings, permission: 'settings.manage' },
  { to: '/audit-logs', label: 'Audit Logs', icon: ScrollText, permission: 'audit.view' },
];

const COLLAPSE_KEY = 'cas.sidebar.collapsed';

export function Layout() {
  const { user, company, can, signOut } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; } });
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);
  useEffect(() => { try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch { /* storage unavailable */ } }, [collapsed]);
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMobileOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  const items = NAV.filter((i) => can(i.permission));

  const sidebar = (mobile: boolean) => {
    const narrow = collapsed && !mobile;
    return (
      <div className="flex h-full flex-col bg-navy-900 text-slate-300">
        <div className={cn('flex h-14 shrink-0 items-center gap-2.5 border-b border-white/10 px-4', narrow && 'justify-center px-0')}>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">{(company?.name ?? 'C').slice(0, 1).toUpperCase()}</div>
          {!narrow && (
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">{company?.name ?? 'Accounting'}</p>
              <p className="truncate text-[11px] text-slate-400">Company Accounting</p>
            </div>
          )}
          {mobile && <button className="ml-auto rounded p-1 text-slate-400 hover:bg-white/10 hover:text-white" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X className="h-5 w-5" /></button>}
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3" aria-label="Main">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              title={narrow ? item.label : undefined}
              className={({ isActive }) => cn(
                'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                narrow && 'justify-center px-0',
                isActive ? 'bg-white/10 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white',
              )}
            >
              {({ isActive }) => (
                <>
                  {isActive && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-brand-500" aria-hidden />}
                  <item.icon className={cn('h-[18px] w-[18px] shrink-0', isActive ? 'text-brand-500' : 'text-slate-400 group-hover:text-slate-200')} aria-hidden />
                  {!narrow && <span className="truncate">{item.label}</span>}
                  {narrow && <span className="sr-only">{item.label}</span>}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="shrink-0 border-t border-white/10 p-2">
          {!narrow && user && (
            <div className="px-3 pb-2 pt-1">
              <p className="truncate text-sm font-medium text-white">{user.fullName}</p>
              <p className="truncate text-xs text-slate-400">{ROLE_LABELS[user.role] ?? user.role} · {user.email}</p>
            </div>
          )}
          <button
            onClick={() => signOut()}
            title={narrow ? 'Logout' : undefined}
            className={cn('flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-slate-300 hover:bg-white/5 hover:text-white', narrow && 'justify-center px-0')}
          >
            <LogOut className="h-[18px] w-[18px] shrink-0 text-slate-400" aria-hidden />
            {!narrow && 'Logout'}
            {narrow && <span className="sr-only">Logout</span>}
          </button>
          {!mobile && (
            <button
              onClick={() => setCollapsed((c) => !c)}
              className={cn('mt-0.5 flex w-full items-center gap-3 rounded-md px-3 py-2 text-xs text-slate-400 hover:bg-white/5 hover:text-white', narrow && 'justify-center px-0')}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" /> Collapse</>}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex min-h-screen">
      {/* Desktop / tablet sidebar */}
      <aside className={cn('no-print sticky top-0 hidden h-screen shrink-0 transition-[width] duration-150 lg:block', collapsed ? 'w-16' : 'w-60')}>{sidebar(false)}</aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="no-print fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-navy-950/60" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 shadow-xl">{sidebar(true)}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 lg:hidden">
          <button className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100" onClick={() => setMobileOpen(true)} aria-label="Open menu"><Menu className="h-5 w-5" /></button>
          <p className="truncate text-sm font-semibold text-slate-900">{company?.name ?? 'Company Accounting'}</p>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
