/** Calendar-date helpers working on 'YYYY-MM-DD' strings in the user's local time zone. */

export type DateRange = { from: string; to: string };
export type PresetKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth' | 'prevMonth' | 'thisFY' | 'custom';

export const PRESETS: Array<{ key: PresetKey; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 Days' },
  { key: 'last30', label: 'Last 30 Days' },
  { key: 'thisMonth', label: 'This Month' },
  { key: 'prevMonth', label: 'Previous Month' },
  { key: 'thisFY', label: 'This Financial Year' },
  { key: 'custom', label: 'Custom Range' },
];

const pad = (n: number) => String(n).padStart(2, '0');
export const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayIso = (now = new Date()) => toIso(now);

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return toIso(new Date(y, m - 1, d + n));
}

export const isIsoDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
};

/** Financial year containing `now`, for a year that starts on the 1st of `fyStartMonth` (1–12). */
export function financialYear(fyStartMonth: number, now = new Date()): DateRange {
  const startYear = now.getMonth() + 1 >= fyStartMonth ? now.getFullYear() : now.getFullYear() - 1;
  return { from: toIso(new Date(startYear, fyStartMonth - 1, 1)), to: toIso(new Date(startYear + 1, fyStartMonth - 1, 0)) };
}

export function presetRange(key: Exclude<PresetKey, 'custom'>, fyStartMonth = 4, now = new Date()): DateRange {
  const today = toIso(now);
  switch (key) {
    case 'today': return { from: today, to: today };
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y }; }
    case 'last7': return { from: addDays(today, -6), to: today };
    case 'last30': return { from: addDays(today, -29), to: today };
    case 'thisMonth': return { from: toIso(new Date(now.getFullYear(), now.getMonth(), 1)), to: today };
    case 'prevMonth': return { from: toIso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: toIso(new Date(now.getFullYear(), now.getMonth(), 0)) };
    case 'thisFY': return { from: financialYear(fyStartMonth, now).from, to: today };
  }
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
