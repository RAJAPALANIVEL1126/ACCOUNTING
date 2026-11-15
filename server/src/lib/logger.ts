import { config } from '../config';

const REDACT = /(password|token|secret|authorization|cookie|csrf)/i;
function scrub(v: unknown, depth = 0): unknown {
  if (v === null || typeof v !== 'object' || depth > 4) return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = REDACT.test(k) ? '[redacted]' : scrub(val, depth + 1);
  return out;
}
function write(level: string, msg: string, extra?: unknown) {
  if (config.isTest && level !== 'error') return;
  const line = { t: new Date().toISOString(), level, msg, ...(extra ? { extra: scrub(extra) } : {}) };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}
export const log = {
  info: (msg: string, extra?: unknown) => write('info', msg, extra),
  warn: (msg: string, extra?: unknown) => write('warn', msg, extra),
  error: (msg: string, extra?: unknown) => write('error', msg, extra),
};
