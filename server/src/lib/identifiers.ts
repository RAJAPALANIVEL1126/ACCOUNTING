/** Validation helpers for Indian business identifiers. All are optional fields: validated only when entered. */
const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

export function gstinCheckDigit(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GST_CHARS.indexOf(first14[i]);
    const product = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GST_CHARS[(36 - (sum % 36)) % 36];
}
export function isValidGstin(v: string): boolean {
  if (!GSTIN_RE.test(v)) return false;
  if (Number(v.slice(0, 2)) < 1) return false;
  return gstinCheckDigit(v.slice(0, 14)) === v[14];
}
export const isValidPan = (v: string) => PAN_RE.test(v);
export const panFromGstin = (gstin: string) => gstin.slice(2, 12);
export const isValidIndianPin = (v: string) => /^[1-9][0-9]{5}$/.test(v);
export const isValidPhone = (v: string) => /^\+?[0-9][0-9 ()-]{6,19}$/.test(v);
