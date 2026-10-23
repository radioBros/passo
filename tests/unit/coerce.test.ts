import { describe, it, expect } from 'vitest';
import { asString, asOptionalString, asNumber } from '../../src/shared/util/coerce.ts';

describe('safe coercion — prevents "[object Object]" corruption', () => {
  it('passes scalars through', () => {
    expect(asString('x', 'f')).toBe('x');
    expect(asString(42, 'f')).toBe('42');
    expect(asString(true, 'f')).toBe('true');
    expect(asString(10n, 'f')).toBe('10');
  });

  it('REFUSES an object — String({}) would silently yield "[object Object]"', () => {
    expect(() => asString({}, 'field')).toThrow(TypeError);
    expect(() => asString([], 'field')).toThrow(TypeError);
    expect(() => asString(null, 'field')).toThrow(/null/);
    expect(() => asString(undefined, 'field')).toThrow(TypeError);
  });

  it('names the offending field so the error is actionable', () => {
    expect(() => asString({}, 'payload.submissionId')).toThrow(/payload\.submissionId/);
  });

  it('asOptionalString yields undefined rather than throwing', () => {
    expect(asOptionalString(undefined)).toBeUndefined();
    expect(asOptionalString(null)).toBeUndefined();
    expect(asOptionalString({})).toBeUndefined();
    expect(asOptionalString('v')).toBe('v');
    expect(asOptionalString(7)).toBe('7');
  });

  it('asNumber accepts numbers and numeric strings', () => {
    expect(asNumber(5, 'f')).toBe(5);
    expect(asNumber('5', 'f')).toBe(5);
    expect(asNumber('5.5', 'f')).toBe(5.5);
  });

  it('asNumber rejects NaN and Infinity', () => {
    expect(() => asNumber(NaN, 'f')).toThrow(TypeError);
    expect(() => asNumber(Infinity, 'f')).toThrow(TypeError);
    expect(() => asNumber('abc', 'f')).toThrow(TypeError);
  });

  it('asNumber uses the fallback when one is given', () => {
    expect(asNumber(undefined, 'f', 7)).toBe(7);
    expect(asNumber({}, 'f', 7)).toBe(7);
  });
});
