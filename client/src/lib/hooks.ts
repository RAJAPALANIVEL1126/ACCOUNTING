import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newIdempotencyKey } from './api';
import { useToast } from './toast';

/** Controlled-form state with server-side field errors. */
export function useForm<T extends Record<string, unknown>>(initial: T) {
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => (e[key as string] ? { ...e, [key as string]: '' } : e));
  }, []);
  const reset = useCallback((next: T) => { setValues(next); setErrors({}); }, []);
  /** Props for a text-like <Input>/<Select>/<Textarea>. */
  const bind = <K extends keyof T>(key: K) => ({
    value: (values[key] ?? '') as string,
    invalid: Boolean(errors[key as string]),
    onChange: (e: { target: { value: string } }) => set(key, e.target.value as T[K]),
  });
  return { values, errors, set, setErrors, setValues, reset, bind };
}

/**
 * Runs a mutation with: a busy flag, one idempotency key per attempt-until-success (so a
 * double click or a retry after a network blip cannot post twice), field-error mapping,
 * toasts, and cache invalidation.
 */
export function useSubmit() {
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());
  const run = useCallback(
    async <R,>(fn: (idempotencyKey: string) => Promise<R>, opts: { success?: string; setErrors?: (e: Record<string, string>) => void; onDone?: (r: R) => void } = {}): Promise<R | undefined> => {
      if (busy) return undefined;
      setBusy(true);
      try {
        const result = await fn(key.current);
        key.current = newIdempotencyKey();
        await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
        if (opts.success) toast.success(opts.success);
        opts.onDone?.(result);
        return result;
      } catch (e) {
        if (e instanceof ApiError) {
          if (Object.keys(e.fields).length && opts.setErrors) opts.setErrors(e.fields);
          // A validation failure released the key on the server; anything else gets a fresh one too.
          if (e.code !== 'DUPLICATE_REQUEST' && e.code !== 'NETWORK') key.current = newIdempotencyKey();
          toast.error(e.message);
        } else toast.error('Something went wrong');
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [busy, qc, toast],
  );
  return { busy, run };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

// ───────────────────────── Shared lookups ─────────────────────────

export interface Account { id: string; code: string; name: string; kind: 'CASH' | 'BANK'; bankName: string | null; bankAccountType: string | null; accountNumberMasked: string | null; openingBalance: string; openingDate: string | null; isActive: boolean; balance: string }
export interface Category { id: string; name: string; type: 'INCOME' | 'EXPENSE'; plGroup: string; isSystem: boolean; isActive: boolean }
export interface Party { id: string; name: string; businessName: string | null; email: string | null; phone: string | null; address: string | null; gstin: string | null; openingBalance: string; outstanding: string; isActive: boolean }
export interface TaxRate { id: string; name: string; rate: string; isActive: boolean }

export const useAccounts = (enabled = true) => useQuery({ queryKey: ['accounts'], queryFn: async () => (await api.get<Account[]>('/accounts')).data, enabled });
export const useCategories = (enabled = true) => useQuery({ queryKey: ['categories'], queryFn: async () => (await api.get<Category[]>('/categories')).data, enabled });
export const useParties = (kind: 'customers' | 'suppliers', enabled = true) => useQuery({ queryKey: [kind, 'all'], queryFn: async () => (await api.get<Party[]>(`/${kind}`, { all: 1 })).data, enabled });
export const useTaxRates = (enabled = true) => useQuery({ queryKey: ['tax-rates'], queryFn: async () => (await api.get<TaxRate[]>('/tax-rates')).data, enabled });
export interface SettingsPayload {
  settings: { accountingMethod: 'ACCRUAL' | 'CASH'; expenseApprovalRequired: boolean; allowSelfApproval: boolean; taxEnabled: boolean; taxLabel: string; invoicePrefix: string; invoiceDueDays: number; invoiceNotes: string | null; invoiceTerms: string | null; notifyExpenseApproval: boolean; notifyPaymentReceived: boolean };
  gateway: { provider: string | null; configured: boolean; mode: 'gateway' | 'recording'; keyId: string | null; message: string };
  security: { passwordMinLength: number; maxFailedLogins: number; lockMinutes: number; sessionTtlHours: number; secureCookies: boolean; emailConfigured: boolean };
}
export const useSettings = (enabled = true) => useQuery({ queryKey: ['settings'], queryFn: async () => (await api.get<SettingsPayload>('/settings')).data, enabled });
