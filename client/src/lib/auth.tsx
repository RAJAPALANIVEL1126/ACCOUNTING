import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setCsrfToken, setUnauthorizedHandler } from './api';

export interface SessionUser { id: string; fullName: string; email: string; phone: string | null; role: string }
export interface SessionCompany { id: string; name: string; baseCurrency: string; fyStartMonth: number; logoAttachmentId: string | null }
export interface Session { user: SessionUser; company: SessionCompany | null; permissions: string[]; csrfToken: string }

interface AuthValue {
  loading: boolean;
  session: Session | null;
  user: SessionUser | null;
  company: SessionCompany | null;
  currency: string;
  fyStartMonth: number;
  can: (permission: string) => boolean;
  signIn: (email: string, password: string) => Promise<Session>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['session'],
    queryFn: async (): Promise<Session | null> => {
      try {
        const { data } = await api.get<Session>('/auth/me');
        setCsrfToken(data.csrfToken);
        return data;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // Any API call that comes back 401 means the session ended (expired, revoked, signed out elsewhere).
  useEffect(() => {
    setUnauthorizedHandler(() => { setCsrfToken(''); qc.setQueryData(['session'], null); });
  }, [qc]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { data } = await api.post<Session>('/auth/login', { email, password });
    setCsrfToken(data.csrfToken);
    // Drop anything cached for a previous user, but keep the session query itself (it has a live observer).
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
    qc.setQueryData(['session'], data);
    return data;
  }, [qc]);

  const signOut = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* the session may already be gone */ }
    setCsrfToken('');
    qc.setQueryData(['session'], null);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
  }, [qc]);

  const refresh = useCallback(async () => { await qc.invalidateQueries({ queryKey: ['session'] }); }, [qc]);

  const session = query.data ?? null;
  const value = useMemo<AuthValue>(() => {
    const perms = new Set(session?.permissions ?? []);
    return {
      loading: query.isLoading,
      session,
      user: session?.user ?? null,
      company: session?.company ?? null,
      currency: session?.company?.baseCurrency ?? 'INR',
      fyStartMonth: session?.company?.fyStartMonth ?? 4,
      // UI convenience only. The server enforces every permission on every request.
      can: (p: string) => perms.has(p),
      signIn, signOut, refresh,
    };
  }, [session, query.isLoading, signIn, signOut, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}

export const ROLE_LABELS: Record<string, string> = { SUPER_ADMIN: 'Super Admin', ADMIN: 'Admin', ACCOUNTANT: 'Accountant', VIEWER: 'Viewer' };
