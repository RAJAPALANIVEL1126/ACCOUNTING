import { z } from 'zod';
import { AppError } from './errors';
import { D, MAX_AMOUNT } from './money';
import { isValidDate } from './dates';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const fields: Record<string, string> = {};
    for (const issue of r.error.issues) {
      const key = issue.path.join('.') || '_';
      if (!fields[key]) fields[key] = issue.message;
    }
    throw new AppError(400, 'VALIDATION_ERROR', 'Please correct the highlighted fields', { fields });
  }
  return r.data;
}

const MONEY_RE = /^\d{1,13}(\.\d{1,2})?$/;
const normalise = (v: unknown) =>
  typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'x') : typeof v === 'string' ? v.trim() || undefined : v === null ? undefined : v;
const moneyString = z
  .string({ required_error: 'Amount is required', invalid_type_error: 'Amount is required' })
  .regex(MONEY_RE, 'Enter a valid non-negative amount with up to 2 decimals')
  // zod runs refinements even after a failed regex, so guard before constructing a Decimal.
  .refine((s) => !MONEY_RE.test(s) || D(s).lte(MAX_AMOUNT), 'Amount is too large');

/** Non-negative money (0 allowed). Rejects negatives, >2 decimals, exponent notation and huge values. */
export const zMoney = z.preprocess(normalise, moneyString.transform((s) => D(s)));
/** Strictly positive money. */
export const zMoneyPositive = z.preprocess(
  normalise,
  moneyString.refine((s) => !MONEY_RE.test(s) || D(s).gt(0), 'Amount must be greater than zero').transform((s) => D(s)),
);
/** Optional money: empty → 0. */
export const zMoneyOptional = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? '0' : normalise(v)),
  moneyString.transform((s) => D(s)),
);

export const zDate = z.string({ required_error: 'Date is required' }).refine(isValidDate, 'Enter a valid date (YYYY-MM-DD)');
export const zDateOptional = z.preprocess((v) => (v === '' || v === null ? undefined : v), zDate.optional());

export const zId = z.preprocess(
  (v) => (v === '' || v === null ? undefined : v),
  z.string({ required_error: 'This field is required', invalid_type_error: 'This field is required' }).min(1, 'This field is required').max(64),
);
export const zIdOptional = z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().min(1).max(64).optional());
export const zText = (max = 500) =>
  z.preprocess(
    (v) => (v === null || v === undefined ? undefined : typeof v === 'string' ? v.trim() || undefined : v),
    z.string().max(max).optional(),
  );
export const zRequiredText = (label: string, max = 200) =>
  z.string({ required_error: `${label} is required` }).trim().min(1, `${label} is required`).max(max);

export const zPage = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});
