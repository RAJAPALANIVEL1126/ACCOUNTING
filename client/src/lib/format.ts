/** Display helpers. Financial arithmetic happens on the server; the client only formats strings. */

const formatters = new Map<string, Intl.NumberFormat>();
function fmt(currency: string, compact = false) {
  const key = currency + (compact ? ':c' : '');
  let f = formatters.get(key);
  if (!f) {
    const locale = currency === 'INR' ? 'en-IN' : 'en-US';
    try {
      f = new Intl.NumberFormat(locale, compact
        ? { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }
        : { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch {
      f = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    formatters.set(key, f);
  }
  return f;
}

export function formatMoney(value: string | number | null | undefined, currency = 'INR'): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? fmt(currency).format(n) : String(value);
}
export function formatCompact(value: string | number, currency = 'INR'): string {
  const n = Number(value);
  return Number.isFinite(n) ? fmt(currency, true).format(n) : String(value);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-03-07' (or an ISO timestamp) → '07 Mar 2026'. Pure string handling: no time-zone shifts. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : value;
}
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${String(d.getDate()).padStart(2, '0')} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** Chart axis label for a day ('2026-03-07' → '07 Mar') or month ('2026-03' → 'Mar 26') bucket. */
export function formatBucket(bucket: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bucket);
  if (day) return `${day[3]} ${MONTHS[Number(day[2]) - 1]}`;
  const month = /^(\d{4})-(\d{2})$/.exec(bucket);
  if (month) return `${MONTHS[Number(month[2]) - 1]} ${month[1].slice(2)}`;
  return bucket;
}

export const titleCase = (s: string | null | undefined) =>
  (s ?? '').toLowerCase().split('_').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

export const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash', BANK_TRANSFER: 'Bank Transfer', UPI: 'UPI', CREDIT_CARD: 'Credit Card', DEBIT_CARD: 'Debit Card', NET_BANKING: 'Net Banking',
  PAYMENT_GATEWAY: 'Payment Gateway', CHEQUE: 'Cheque', CREDIT: 'On Credit (unpaid)', OTHER: 'Other',
};
export const methodLabel = (m: string | null | undefined) => (m ? METHOD_LABELS[m] ?? titleCase(m) : '—');

export const TYPE_LABELS: Record<string, string> = {
  INCOME: 'Income', EXPENSE: 'Expense', TRANSFER: 'Transfer', ADJUSTMENT: 'Adjustment', RECEIPT: 'Customer Receipt',
  SUPPLIER_PAYMENT: 'Supplier Payment', REFUND: 'Refund', OPENING_BALANCE: 'Opening Balance',
};
export const typeLabel = (t: string) => TYPE_LABELS[t] ?? titleCase(t);

/** Parse a user-typed amount into paise for *preview only* (the server recomputes everything). */
export function toPaise(v: string | number | null | undefined): number {
  const s = String(v ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return 0;
  const [i, d = ''] = s.split('.');
  return Number(i) * 100 + Number((d + '00').slice(0, 2));
}
export const fromPaise = (p: number) => (p / 100).toFixed(2);

export const fileSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
