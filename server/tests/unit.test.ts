import { describe, expect, it } from 'vitest';
import { D, fromMinorUnits, money, round2, sum, toMinorUnits } from '../src/lib/money';
import { calcInvoice } from '../src/lib/invoiceCalc';
import { gstinCheckDigit, isValidGstin, isValidIndianPin, isValidPan, isValidPhone } from '../src/lib/identifiers';
import { addDays, eachDay, eachMonth, isValidDate, previousPeriod } from '../src/lib/dates';
import { parse, zDate, zMoney, zMoneyPositive } from '../src/lib/validate';
import { verifyWebhookSignature } from '../src/services/gateway';
import { sniff } from '../src/routes/attachments';
import { toCsv } from '../src/services/exporter';
import { ROLE_PERMISSIONS } from '../src/lib/permissions';
import crypto from 'crypto';

describe('money', () => {
  it('never uses binary floating point', () => {
    expect(money(D('0.1').plus('0.2'))).toBe('0.30');
    expect(money(sum(['0.10', '0.20', '0.30']))).toBe('0.60');
  });
  it('rounds half-up to 2 places', () => {
    expect(round2(D('1.005')).toFixed(2)).toBe('1.01');
    expect(round2(D('2.675')).toFixed(2)).toBe('2.68');
    expect(round2(D('1.004')).toFixed(2)).toBe('1.00');
  });
  it('converts to and from integer minor units for payment providers', () => {
    expect(toMinorUnits('1234.56')).toBe(123456);
    expect(toMinorUnits('0.07')).toBe(7);
    expect(money(fromMinorUnits(123456))).toBe('1234.56');
  });
  it('keeps precision on very large amounts', () => {
    expect(money(D('9999999999999.99').minus('0.01'))).toBe('9999999999999.98');
  });
});

describe('money validation', () => {
  it('accepts valid amounts', () => {
    expect(parse(zMoney, '100.50').toFixed(2)).toBe('100.50');
    expect(parse(zMoney, 0).toFixed(2)).toBe('0.00');
  });
  it.each(['-5', '1.234', 'abc', '1e5', '', '99999999999999', 'NaN', '1,000'])('rejects %s', (v) => {
    expect(() => parse(zMoney, v)).toThrow();
  });
  it('rejects zero when a positive amount is required', () => {
    expect(() => parse(zMoneyPositive, '0')).toThrow();
    expect(() => parse(zMoneyPositive, '0.00')).toThrow();
    expect(parse(zMoneyPositive, '0.01').toFixed(2)).toBe('0.01');
  });
});

describe('dates', () => {
  it('validates real calendar dates only', () => {
    expect(isValidDate('2026-02-28')).toBe(true);
    expect(isValidDate('2024-02-29')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('28/02/2026')).toBe(false);
    expect(() => parse(zDate, 'not-a-date')).toThrow();
  });
  it('builds day and month buckets', () => {
    expect(eachDay('2026-02-27', '2026-03-02')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(eachMonth('2025-11-15', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('computes the previous period of equal length', () => {
    expect(previousPeriod('2026-03-01', '2026-03-31')).toEqual({ from: '2026-01-29', to: '2026-02-28' });
  });
});

describe('invoice totals', () => {
  it('computes line and document totals with discount and tax', () => {
    const r = calcInvoice([
      { quantity: '2', unitPrice: '500.00', discount: '100.00', taxRate: '18' },
      { quantity: '1.5', unitPrice: '333.33', discount: '0', taxRate: '5' },
    ]);
    expect(r.items[0].lineNet.toFixed(2)).toBe('900.00');
    expect(r.items[0].lineTax.toFixed(2)).toBe('162.00');
    expect(r.items[1].lineGross.toFixed(2)).toBe('500.00'); // 499.995 → 500.00 half-up
    expect(r.items[1].lineTax.toFixed(2)).toBe('25.00');
    expect(r.subtotal.toFixed(2)).toBe('1500.00');
    expect(r.discountTotal.toFixed(2)).toBe('100.00');
    expect(r.taxTotal.toFixed(2)).toBe('187.00');
    expect(r.total.toFixed(2)).toBe('1587.00');
  });
  it('supports invoices without any tax', () => {
    const r = calcInvoice([{ quantity: '3', unitPrice: '99.99' }]);
    expect(r.taxTotal.toFixed(2)).toBe('0.00');
    expect(r.total.toFixed(2)).toBe('299.97');
  });
  it('document total always equals the sum of its lines', () => {
    const r = calcInvoice(Array.from({ length: 25 }, (_, i) => ({ quantity: '0.333', unitPrice: (i * 7.77 + 0.01).toFixed(2), taxRate: '12.5' })));
    expect(r.total.toFixed(2)).toBe(sum(r.items.map((i) => i.lineTotal)).toFixed(2));
  });
  it('rejects invalid lines', () => {
    expect(() => calcInvoice([{ quantity: '0', unitPrice: '10' }])).toThrow();
    expect(() => calcInvoice([{ quantity: '1', unitPrice: '10', discount: '11' }])).toThrow();
    expect(() => calcInvoice([{ quantity: '1', unitPrice: '10', taxRate: '101' }])).toThrow();
  });
});

describe('Indian business identifiers', () => {
  it('validates GSTIN format and check digit', () => {
    const base = '27AAPFU0939F1Z';
    const valid = base + gstinCheckDigit(base);
    expect(isValidGstin(valid)).toBe(true);
    expect(isValidGstin('27AAPFU0939F1ZV')).toBe(true); // widely published sample GSTIN
    const wrong = base + (valid[14] === 'A' ? 'B' : 'A');
    expect(isValidGstin(wrong)).toBe(false);
    expect(isValidGstin('27AAPFU0939F1Z')).toBe(false);
    expect(isValidGstin('ABCDEFGHIJKLMNO')).toBe(false);
  });
  it('validates PAN, PIN code and phone', () => {
    expect(isValidPan('AAPFU0939F')).toBe(true);
    expect(isValidPan('AAPFU0939')).toBe(false);
    expect(isValidIndianPin('560001')).toBe(true);
    expect(isValidIndianPin('056001')).toBe(false);
    expect(isValidPhone('+91 98765 43210')).toBe(true);
    expect(isValidPhone('abc')).toBe(false);
  });
});

describe('webhook signature', () => {
  const secret = 'whsec_test';
  const body = Buffer.from(JSON.stringify({ event: 'payment.captured' }));
  const good = crypto.createHmac('sha256', secret).update(body).digest('hex');
  it('accepts a correct signature', () => expect(verifyWebhookSignature(body, good, secret)).toBe(true));
  it('rejects a tampered body', () => expect(verifyWebhookSignature(Buffer.from(body.toString() + ' '), good, secret)).toBe(false));
  it('rejects a wrong, missing or malformed signature', () => {
    expect(verifyWebhookSignature(body, good.replace(/.$/, good.endsWith('0') ? '1' : '0'), secret)).toBe(false);
    expect(verifyWebhookSignature(body, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature(body, 'zz', secret)).toBe(false);
    expect(verifyWebhookSignature(body, good, '')).toBe(false);
  });
});

describe('upload sniffing', () => {
  it('trusts magic bytes, not names', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
    expect(sniff(png)?.mime).toBe('image/png');
    expect(sniff(Buffer.from('%PDF-1.7 ............'))?.mime).toBe('application/pdf');
    expect(sniff(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniff(Buffer.from('MZ\x90\x00 fake exe renamed .png ......'))).toBeNull();
  });
});

describe('exports', () => {
  it('neutralises spreadsheet formulas in CSV text cells', () => {
    const csv = toCsv({
      key: 'x', title: 'T', columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B', type: 'money' }],
      rows: [{ a: '=HYPERLINK("http://evil")', b: '-10.00' }],
      meta: { companyName: 'C', currency: 'INR', from: '2026-01-01', to: '2026-01-31', generatedAt: 'now', accountingMethod: 'ACCRUAL', basis: 'Accrual', filters: {} },
    });
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(csv).toContain(',-10.00');
  });
});

describe('role matrix', () => {
  it('only SUPER_ADMIN can authorise administrators', () => {
    expect(ROLE_PERMISSIONS.SUPER_ADMIN).toContain('admins.manage');
    for (const r of ['ADMIN', 'ACCOUNTANT', 'VIEWER'] as const) expect(ROLE_PERMISSIONS[r]).not.toContain('admins.manage');
  });
  it('viewers have no write permissions', () => {
    for (const p of ROLE_PERMISSIONS.VIEWER) expect(p.endsWith('.view')).toBe(true);
  });
  it('accountants cannot manage users, settings or approve expenses', () => {
    for (const p of ['users.manage', 'users.view', 'settings.manage', 'expenses.approve', 'transactions.reverse', 'audit.view', 'adjustments.create'] as const) {
      expect(ROLE_PERMISSIONS.ACCOUNTANT).not.toContain(p);
    }
  });
});
