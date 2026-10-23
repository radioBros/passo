import { Decimal } from 'decimal.js';

/**
 * FatturaPA money is a *patterned string*, not a number.
 *
 *   Amount2DecimalType  [\-]?[0-9]{1,11}\.[0-9]{2}      exactly 2 dp, mandatory
 *   Amount8DecimalType  [\-]?[0-9]{1,11}\.[0-9]{2,8}    2..8 dp
 *   RateType            [0-9]{1,3}\.[0-9]{2}  max 100.00
 *   QuantitaType        [0-9]{1,12}\.[0-9]{2,8}
 *
 * Verified against Schema_VFPR12_v1.2.3.xsd. Two traps:
 *   1. The trailing ".00" is MANDATORY. "1000" is schema-invalid; "1000.00" is valid.
 *      A JSON number 1000 serialises as `1000` and is rejected by SdI.
 *   2. Max 11 integer digits. Not "any decimal".
 * See development/research/xsd_extraction_research.md finding 5.
 */

Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_UP });

export const MAX_INTEGER_DIGITS = 11;

export const AMOUNT_2DP = /^-?\d{1,11}\.\d{2}$/;
export const AMOUNT_8DP = /^-?\d{1,11}\.\d{2,8}$/;
export const RATE = /^\d{1,3}\.\d{2}$/;
export const QUANTITA = /^\d{1,12}\.\d{2,8}$/;

export class MoneyError extends Error {}

/** Parse a caller-supplied decimal string. Rejects floats, NaN, and over-long integers. */
export function toDecimal(input: string, field: string): Decimal {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new MoneyError(`${field}: expected a decimal string, got ${typeof input}`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(input)) {
    throw new MoneyError(`${field}: "${input}" is not a plain decimal string`);
  }
  const d = new Decimal(input);
  if (!d.isFinite()) throw new MoneyError(`${field}: not finite`);
  const intDigits = d.abs().trunc().toFixed(0).replace('0', '').length === 0
    ? 1
    : d.abs().trunc().toFixed(0).length;
  if (intDigits > MAX_INTEGER_DIGITS) {
    throw new MoneyError(
      `${field}: ${intDigits} integer digits exceeds FatturaPA maximum of ${MAX_INTEGER_DIGITS}`,
    );
  }
  return d;
}

/**
 * Serialise for FatturaPA with a fixed number of decimals. Always pads — never
 * emits a bare integer.
 *
 * The digit check runs on the ROUNDED OUTPUT, not the input. Checking the input
 * missed the carry: `99999999999.999` has eleven integer digits and rounds to
 * `"100000000000.00"`, which has twelve — schema-invalid, and it passed every
 * local gate before earning an NS from SdI. NS is terminal, so the cost of that
 * miss is a reissued invoice.
 */
export function fmt(d: Decimal, dp: 2 | 8 = 2): string {
  const s = d.toFixed(dp, Decimal.ROUND_HALF_UP);
  const intDigits = s.replace('-', '').split('.')[0]!.length;
  if (intDigits > MAX_INTEGER_DIGITS) {
    throw new MoneyError(
      `value rounds to ${intDigits} integer digits, exceeding the FatturaPA maximum ` +
      `of ${MAX_INTEGER_DIGITS}: ${s}`,
    );
  }
  return s;
}

/** 2-dp amount (ImponibileImporto, Imposta, PrezzoTotale, totals). */
export const fmtAmount = (d: Decimal): string => fmt(d, 2);

/** Unit price: 2 dp minimum, up to 8 significant. Trailing zeros beyond 2 dp are trimmed. */
export function fmtUnitPrice(d: Decimal): string {
  const wide = d.toFixed(8, Decimal.ROUND_HALF_UP);
  const trimmed = wide.replace(/(\.\d{2}\d*?)0+$/, '$1');
  const out = /\.\d{2,}$/.test(trimmed) ? trimmed : d.toFixed(2);
  if (!AMOUNT_8DP.test(out)) throw new MoneyError(`unit price not Amount8DecimalType: ${out}`);
  return out;
}

/** VAT rate as decimal percent — "22.00", never basis points, never 22. */
export function fmtRate(d: Decimal): string {
  if (d.lt(0) || d.gt(100)) throw new MoneyError(`rate out of range 0..100: ${d.toString()}`);
  const out = d.toFixed(2, Decimal.ROUND_HALF_UP);
  if (!RATE.test(out)) throw new MoneyError(`rate not RateType: ${out}`);
  return out;
}

export function fmtQuantita(d: Decimal): string {
  if (d.lt(0)) throw new MoneyError(`quantity may not be negative: ${d.toString()}`);
  const wide = d.toFixed(8, Decimal.ROUND_HALF_UP);
  const trimmed = wide.replace(/(\.\d{2}\d*?)0+$/, '$1');
  const out = /\.\d{2,}$/.test(trimmed) ? trimmed : d.toFixed(2);
  if (!QUANTITA.test(out)) throw new MoneyError(`quantity not QuantitaType: ${out}`);
  return out;
}

export { Decimal };
export type DecimalValue = Decimal;
