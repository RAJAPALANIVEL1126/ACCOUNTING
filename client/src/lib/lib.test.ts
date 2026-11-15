import { describe, expect, it } from 'vitest';
import { addDays, financialYear, isIsoDate, presetRange, toIso } from './dates';
import { formatBucket, formatDate, formatMoney, fromPaise, methodLabel, titleCase, toPaise } from './format';
import { qs } from './api';

describe('date presets', () => {
  const now = new Date(2026, 10, 15); // 15 Nov 2026, local time
  it('today / yesterday / rolling windows', () => {
    expect(presetRange('today', 4, now)).toEqual({ from: '2026-11-15', to: '2026-11-15' });
    expect(presetRange('yesterday', 4, now)).toEqual({ from: '2026-11-14', to: '2026-11-14' });
    expect(presetRange('last7', 4, now)).toEqual({ from: '2026-11-09', to: '2026-11-15' });
    expect(presetRange('last30', 4, now)).toEqual({ from: '2026-10-17', to: '2026-11-15' });
  });
  it('this month and previous month', () => {
    expect(presetRange('thisMonth', 4, now)).toEqual({ from: '2026-11-01', to: '2026-11-15' });
    expect(presetRange('prevMonth', 4, now)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('prevMonth', 4, new Date(2026, 0, 10))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(presetRange('prevMonth', 4, new Date(2024, 2, 31))).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });
  it('financial year follows the configured start month', () => {
    expect(financialYear(4, now)).toEqual({ from: '2026-04-01', to: '2027-03-31' });
    expect(financialYear(4, new Date(2026, 1, 1))).toEqual({ from: '2025-04-01', to: '2026-03-31' });
    expect(financialYear(1, now)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(presetRange('thisFY', 4, now)).toEqual({ from: '2026-04-01', to: '2026-11-15' });
  });
  it('date arithmetic crosses month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(toIso(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
  });
});

describe('formatting', () => {
  it('formats money with Indian digit grouping for INR', () => {
    expect(formatMoney('1234567.5', 'INR').replace(/\s/g, '')).toBe('₹12,34,567.50');
    expect(formatMoney('-250', 'INR')).toContain('250.00');
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney('1000', 'USD')).toBe('$1,000.00');
  });
  it('formats dates without time-zone drift', () => {
    expect(formatDate('2026-03-07')).toBe('07 Mar 2026');
    expect(formatDate('2026-03-07T00:00:00.000Z')).toBe('07 Mar 2026');
    expect(formatDate(null)).toBe('—');
    expect(formatBucket('2026-03-07')).toBe('07 Mar');
    expect(formatBucket('2026-03')).toBe('Mar 26');
  });
  it('labels enums', () => {
    expect(titleCase('PARTIALLY_PAID')).toBe('Partially Paid');
    expect(methodLabel('NET_BANKING')).toBe('Net Banking');
  });
  it('previews amounts in integer paise', () => {
    expect(toPaise('10.5')).toBe(1050);
    expect(toPaise('0.07')).toBe(7);
    expect(toPaise('abc')).toBe(0);
    expect(toPaise('-5')).toBe(0);
    expect(fromPaise(toPaise('0.10') + toPaise('0.20'))).toBe('0.30');
  });
});

describe('query strings', () => {
  it('skips empty values and encodes the rest', () => {
    expect(qs({ a: 1, b: '', c: undefined, d: null, e: 'x y', f: false })).toBe('?a=1&e=x+y&f=false');
    expect(qs({})).toBe('');
  });
});
