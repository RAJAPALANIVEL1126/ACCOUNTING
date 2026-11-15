import { D, Dec, round2, sum, ZERO } from './money';
import { AppError } from './errors';

export interface CalcItemInput {
  quantity: Dec | string | number;
  unitPrice: Dec | string | number;
  discount?: Dec | string | number | null;
  taxRate?: Dec | string | number | null;
}
export interface CalcItem {
  lineGross: Dec;
  discount: Dec;
  lineNet: Dec;
  lineTax: Dec;
  lineTotal: Dec;
}
export interface CalcInvoice {
  items: CalcItem[];
  subtotal: Dec; // sum of quantity × unit price, before discount
  discountTotal: Dec;
  taxTotal: Dec;
  total: Dec;
}

/**
 * Server-side invoice arithmetic. Each line is rounded to 2 places (half-up) and
 * document totals are the sum of rounded lines, so the document always foots.
 */
export function calcInvoice(items: CalcItemInput[]): CalcInvoice {
  const out: CalcItem[] = items.map((it, i) => {
    const qty = D(it.quantity);
    const price = D(it.unitPrice);
    const discount = round2(D(it.discount ?? 0));
    const rate = D(it.taxRate ?? 0);
    if (qty.lte(0)) throw new AppError(400, 'VALIDATION_ERROR', `Line ${i + 1}: quantity must be greater than zero`);
    if (price.lt(0)) throw new AppError(400, 'VALIDATION_ERROR', `Line ${i + 1}: unit price cannot be negative`);
    if (rate.lt(0) || rate.gt(100)) throw new AppError(400, 'VALIDATION_ERROR', `Line ${i + 1}: tax rate must be between 0 and 100`);
    const lineGross = round2(qty.times(price));
    if (discount.lt(0) || discount.gt(lineGross)) throw new AppError(400, 'VALIDATION_ERROR', `Line ${i + 1}: discount cannot exceed the line amount`);
    const lineNet = lineGross.minus(discount);
    const lineTax = round2(lineNet.times(rate).div(100));
    return { lineGross, discount, lineNet, lineTax, lineTotal: lineNet.plus(lineTax) };
  });
  const subtotal = sum(out.map((o) => o.lineGross));
  const discountTotal = sum(out.map((o) => o.discount));
  const taxTotal = sum(out.map((o) => o.lineTax));
  const total = out.length ? subtotal.minus(discountTotal).plus(taxTotal) : ZERO;
  return { items: out, subtotal, discountTotal, taxTotal, total };
}
