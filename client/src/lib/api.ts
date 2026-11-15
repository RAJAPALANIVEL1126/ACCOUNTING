/** Thin fetch wrapper: same-origin cookies, CSRF header, idempotency keys, and a uniform error type. */

let csrfToken = '';
export const setCsrfToken = (t: string) => { csrfToken = t; };

export class ApiError extends Error {
  status: number;
  code: string;
  fields: Record<string, string>;
  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export interface ApiResult<T, M = Record<string, unknown>> { data: T; meta: M }
type Query = Record<string, string | number | boolean | undefined | null>;

export function qs(query?: Query): string {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? '?' + s : '';
}

export const newIdempotencyKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

interface Options { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; query?: Query; idempotencyKey?: string; form?: FormData }

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

async function toError(res: Response): Promise<ApiError> {
  let code = 'ERROR', message = res.status >= 500 ? 'The server could not complete the request. Please try again.' : `Request failed (${res.status})`, fields = {};
  try {
    const body = await res.json();
    if (body?.error) { code = body.error.code ?? code; message = body.error.message ?? message; fields = body.error.details?.fields ?? {}; }
  } catch { /* non-JSON error body */ }
  return new ApiError(res.status, code, message, fields);
}

export async function request<T, M = Record<string, unknown>>(path: string, o: Options = {}): Promise<ApiResult<T, M>> {
  const method = o.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  if (o.idempotencyKey) headers['Idempotency-Key'] = o.idempotencyKey;
  let body: BodyInit | undefined;
  if (o.form) body = o.form;
  else if (o.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body); }

  let res: Response;
  try {
    res = await fetch('/api' + path + qs(o.query), { method, headers, body, credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');
  }
  if (!res.ok) {
    const err = await toError(res);
    if (res.status === 401 && err.code === 'UNAUTHENTICATED' && !path.startsWith('/auth/')) onUnauthorized?.();
    throw err;
  }
  const json = await res.json();
  return { data: json.data as T, meta: (json.meta ?? {}) as M };
}

export const api = {
  get: <T, M = Record<string, unknown>>(path: string, query?: Query) => request<T, M>(path, { query }),
  post: <T>(path: string, body?: unknown, idempotencyKey?: string) => request<T>(path, { method: 'POST', body: body ?? {}, idempotencyKey }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body ?? {} }),
  upload: <T>(path: string, file: File) => { const form = new FormData(); form.append('file', file); return request<T>(path, { method: 'POST', form }); },
};

/** Authenticated file download (CSV / Excel / PDF exports). */
export async function download(path: string, query?: Query, fallbackName = 'export') {
  const res = await fetch('/api' + path + qs(query), { credentials: 'same-origin' });
  if (!res.ok) throw await toError(res);
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');
