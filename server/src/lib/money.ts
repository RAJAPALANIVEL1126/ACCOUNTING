import { Prisma } from '@prisma/client';

/**
 * Money policy
 *  - All monetary values are decimal.js Decimals (never JS floats).
 *  - Stored as NUMERIC(18,2); every computed value is rounded to 2 places, ROUND_HALF_UP.
 *  - Payment-provider APIs use integer minor units (paise) via toMinorUnits / fromMinorUnits.
 */
export type Dec = Prisma.Decimal;
export const D = (v: Prisma.Decimal.Value | null | undefined): Dec => new Prisma.Decimal(v ?? 0);
export const ZERO = D(0);
export const round2 = (d: Dec): Dec => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
export const sum = (xs: Array<Prisma.Decimal.Value | null | undefined>): Dec => xs.reduce<Dec>((a, b) => a.plus(D(b)), ZERO);
export const money = (v: Prisma.Decimal.Value | null | undefined): string => round2(D(v)).toFixed(2);
export const toMinorUnits = (v: Prisma.Decimal.Value): number => Number(round2(D(v)).times(100).toFixed(0));
export const fromMinorUnits = (n: number): Dec => round2(D(n).div(100));
export const MAX_AMOUNT = D('9999999999999.99');
