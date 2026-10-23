import { describe, it, expect } from 'vitest';
import {
  toDecimal, fmtAmount, fmtUnitPrice, fmtRate, fmtQuantita,
  MoneyError, AMOUNT_2DP, AMOUNT_8DP, RATE, Decimal,
} from '../../src/shared/util/money.ts';

describe('FatturaPA money serialisation', () => {
  it('always emits the mandatory trailing .00 — "1000" is schema-invalid', () => {
    expect(fmtAmount(toDecimal('1000', 'x'))).toBe('1000.00');
    expect(AMOUNT_2DP.test(fmtAmount(toDecimal('1000', 'x')))).toBe(true);
  });

  it('rounds half-up to 2 dp', () => {
    expect(fmtAmount(toDecimal('1.005', 'x'))).toBe('1.01');
    expect(fmtAmount(toDecimal('2.344', 'x'))).toBe('2.34');
  });

  it('rejects more than 11 integer digits', () => {
    expect(() => toDecimal('123456789012', 'total')).toThrow(MoneyError);
    expect(() => toDecimal('99999999999', 'total')).not.toThrow();
  });

  it('rejects non-decimal strings and non-strings', () => {
    for (const bad of ['1e3', 'abc', '1,00', '', ' ']) {
      expect(() => toDecimal(bad, 'x'), bad).toThrow(MoneyError);
    }
    // @ts-expect-error runtime guard for untyped callers
    expect(() => toDecimal(1000, 'x')).toThrow(MoneyError);
  });

  it('permits negative amounts (credit notes TD04/TD05)', () => {
    expect(fmtAmount(toDecimal('-500.50', 'x'))).toBe('-500.50');
    expect(AMOUNT_2DP.test('-500.50')).toBe(true);
  });

  it('unit price keeps up to 8 dp, minimum 2', () => {
    expect(fmtUnitPrice(toDecimal('10.12345678', 'x'))).toBe('10.12345678');
    expect(fmtUnitPrice(toDecimal('10', 'x'))).toBe('10.00');
    expect(fmtUnitPrice(toDecimal('10.5', 'x'))).toBe('10.50');
    expect(AMOUNT_8DP.test(fmtUnitPrice(toDecimal('10.123', 'x')))).toBe(true);
  });

  it('VAT rate is decimal percent, never basis points', () => {
    expect(fmtRate(toDecimal('22', 'r'))).toBe('22.00');
    expect(fmtRate(toDecimal('4', 'r'))).toBe('4.00');
    expect(fmtRate(toDecimal('0', 'r'))).toBe('0.00');
    expect(RATE.test(fmtRate(toDecimal('22', 'r')))).toBe(true);
    // 2200 basis points must NOT be accepted as a rate
    expect(() => fmtRate(toDecimal('2200', 'r'))).toThrow(MoneyError);
  });

  it('rejects negative quantity and negative rate', () => {
    expect(() => fmtQuantita(toDecimal('-1', 'q'))).toThrow(MoneyError);
    expect(() => fmtRate(toDecimal('-1', 'r'))).toThrow(MoneyError);
  });

  it('float arithmetic does not leak in', () => {
    const sum = new Decimal('0.1').plus('0.2');
    expect(fmtAmount(sum)).toBe('0.30');   // 0.30000000000000004 in binary float
  });
});

/**
 * Rounding must not carry past the FatturaPA digit limit.
 *
 * The check used to run on the INPUT, which misses the carry:
 * `99999999999.999` has eleven integer digits and rounds to
 * `"100000000000.00"`, which has twelve. That is schema-invalid and passed
 * every local gate — the failure surfaced as an NS from SdI, which is terminal
 * and costs a reissued invoice.
 */
describe('rounding overflow', () => {
  it('REFUSES a value that rounds up past 11 integer digits', () => {
    expect(() => fmtAmount(toDecimal('99999999999.999', 'x')))
      .toThrow(/rounds to 12 integer digits/);
  });

  it('refuses it for a NEGATIVE value too — credit notes carry the same limit', () => {
    expect(() => fmtAmount(toDecimal('-99999999999.999', 'x')))
      .toThrow(/12 integer digits/);
  });

  it('still accepts the largest legal amount', () => {
    expect(fmtAmount(toDecimal('99999999999.99', 'x'))).toBe('99999999999.99');
  });

  it('rounds normally well inside the limit', () => {
    expect(fmtAmount(toDecimal('1000.505', 'x'))).toBe('1000.51');
    expect(fmtAmount(toDecimal('1000.5', 'x'))).toBe('1000.50');
  });

  it('names the offending value, so the CRM can find the field', () => {
    expect(() => fmtAmount(toDecimal('99999999999.999', 'x')))
      .toThrow(/100000000000\.00/);
  });
});
