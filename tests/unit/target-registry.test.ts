import { describe, it, expect } from 'vitest';
import { TARGET_PATHS, isValidTarget, suggestTargets } from '../../src/domain/transform/targets.ts';
import { validateTemplate, TransformError } from '../../src/domain/transform/engine.ts';

/**
 * The target-path registry (XFORM-005).
 *
 * DERIVED from `InvoiceSchema`, not hand-listed. A hand-maintained list drifts,
 * and a rule pointing at a target the generator does not read writes into an
 * object nobody looks at: the field is silently absent from the XML, and if it
 * was optional the invoice transmits missing data with no error anywhere.
 */
describe('target registry', () => {
  it('covers every top-level area of the canonical model', () => {
    for (const area of ['number', 'date', 'seller.name', 'buyer.name',
                        'lines[].unitPrice', 'summaries[].taxAmount',
                        'payment.iban', 'attachments[].name']) {
      expect(isValidTarget(area), area).toBe(true);
    }
  });

  it('is derived, not hand-written — it tracks the schema', () => {
    // Nothing here is spelled out in targets.ts; all of it comes from Zod.
    expect(TARGET_PATHS.length).toBeGreaterThan(40);
    expect(TARGET_PATHS).toContain('seller.address.postalCode');
    expect(TARGET_PATHS).toContain('lines[].vatRate');
  });

  it('accepts an INDEXED array path, since a trace reports lines[0]', () => {
    expect(isValidTarget('lines[0].unitPrice')).toBe(true);
    expect(isValidTarget('summaries[3].taxableAmount')).toBe(true);
  });

  it('REJECTS a path the generator does not read', () => {
    expect(isValidTarget('lines[].unitPrise')).toBe(false);
    expect(isValidTarget('totallyMadeUp')).toBe(false);
    expect(isValidTarget('seller.vatId.codice')).toBe(false);
  });

  /**
   * A rejection naming only the offending path leaves the author scanning
   * sixty-odd entries; the cause is nearly always a casing slip or a
   * singular/plural mix-up in the final segment.
   */
  it('suggests the intended path for a typo', () => {
    expect(suggestTargets('lines[].unitPrise')).toContain('lines[].unitPrice');
    expect(suggestTargets('summaries[].taxAmout')).toContain('summaries[].taxAmount');
    expect(suggestTargets('line[].description')).toContain('lines[].description');
  });

  it('refuses a bad target at SAVE time, while the author is still there', () => {
    expect(() => validateTemplate({
      name: 't', rules: [{ target: 'lines[].unitPrise', source: 'x' }],
    })).toThrow(TransformError);
  });

  it('names the suggestion in the rejection', () => {
    expect(() => validateTemplate({
      name: 't', rules: [{ target: 'lines[].unitPrise', source: 'x' }],
    })).toThrow(/Did you mean "lines\[\]\.unitPrice"/);
  });

  it('still accepts a valid template', () => {
    expect(() => validateTemplate({
      name: 't', rules: [{ target: 'number', source: 'doc_no' }],
    })).not.toThrow();
  });
});
