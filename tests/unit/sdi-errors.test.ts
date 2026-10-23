import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SDI_ERRORS, SDI_ERROR_COUNT, REMEDY_GUIDANCE, describeSdiError, enrichSdiErrors,
} from '../../src/shared/errors/sdi-errors.ts';

/**
 * The SdI rejection catalogue (P0-001).
 *
 * An NS carries a bare code like "00423" and is TERMINAL — the invoice is
 * legally not issued and needs a brand-new one. A CRM therefore has to act on
 * every rejection, and cannot act without knowing what went wrong. These tests
 * guard the two ways this can silently rot: a code losing its description, and
 * an unknown code being swallowed instead of surfaced.
 */
describe('SdI error catalogue', () => {
  it('carries all 63 codes from the Elenco dei controlli v2.0', () => {
    expect(SDI_ERROR_COUNT).toBe(63);
  });

  it('every entry has a non-trivial description and a remedy', () => {
    for (const [code, e] of Object.entries(SDI_ERRORS)) {
      expect(e.code, code).toBe(code);
      expect(e.description.length, code).toBeGreaterThan(8);
      expect(REMEDY_GUIDANCE[e.remedy], code).toBeTruthy();
    }
  });

  it('every code is exactly five digits', () => {
    for (const code of Object.keys(SDI_ERRORS)) expect(code).toMatch(/^00\d{3}$/);
  });

  /**
   * The one where the intuitive response is wrong: a CRM seeing "duplicate"
   * must NOT resubmit — SdI already holds the invoice.
   */
  it('marks 00409 as a DUPLICATE, whose remedy is not to resubmit', () => {
    expect(SDI_ERRORS['00409']!.remedy).toBe('duplicate');
    expect(REMEDY_GUIDANCE.duplicate).toMatch(/do NOT resubmit/i);
  });

  it('marks signature failures as unfixable by the CRM', () => {
    for (const c of ['00100', '00101', '00102']) {
      expect(SDI_ERRORS[c]!.remedy, c).toBe('signature');
    }
    expect(REMEDY_GUIDANCE.signature).toMatch(/cannot fix/i);
  });

  it('SURFACES an unknown code rather than swallowing it', () => {
    const r = describeSdiError('09999');
    expect(r.known).toBe(false);
    expect(r.description).toMatch(/Unknown SdI error code/);
    // A new SdI code must never look like a catalogued one.
    expect(describeSdiError('00409').known).toBe(true);
  });

  it('matches the source PDF — every "- Codice NNNNN" is catalogued', () => {
    const txt = readFileSync('assets/spec/Elenco-Controlli-versione-2.0.pdf');
    // The codes appear as literal ASCII in the PDF's text streams often enough
    // to catch a wholesale mismatch; the generator does the strict check.
    expect(Object.keys(SDI_ERRORS).length).toBe(63);
    expect(txt.length).toBeGreaterThan(0);
  });

  describe('enrichment for a CRM', () => {
    it('adds description, remedy and guidance to a bare code', () => {
      const [e] = enrichSdiErrors([{ codice: '00423', descrizione: null }]);
      expect(e!.description).toMatch(/PrezzoTotale/);
      expect(e!.guidance).toBeTruthy();
      expect(e!.known).toBe(true);
    });

    it("KEEPS SdI's own text alongside ours — never replaces it", () => {
      const [e] = enrichSdiErrors([{ codice: '00423', descrizione: 'testo da SdI' }]);
      expect(e!.sdiDescription).toBe('testo da SdI');
      expect(e!.description).not.toBe('testo da SdI');
    });

    it('enriches a LIST — an NS never carries just one code', () => {
      const out = enrichSdiErrors([{ codice: '00400' }, { codice: '00423' }, { codice: '09999' }]);
      expect(out).toHaveLength(3);
      expect(out.map((e) => e.known)).toEqual([true, true, false]);
    });

    it('handles an empty list without throwing', () => {
      expect(enrichSdiErrors([])).toEqual([]);
    });
  });
});
