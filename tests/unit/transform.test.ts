import { describe, it, expect } from 'vitest';
import {
  validateTemplate, applyTemplate, assertSafeRegex, isMonetaryTarget,
  ALLOWED_FUNCTIONS, TransformError, LIMITS,
} from '../../src/domain/transform/engine.ts';

describe('NO code execution — the defining constraint', () => {
  it('rejects any function outside the whitelist', () => {
    for (const evil of ['eval', 'Function', 'require', 'exec', 'constructor', '__proto__']) {
      expect(() => validateTemplate({
        name: 'x', rules: [{ target: 'number', source: 'b', transform: [{ fn: evil }] }],
      }), evil).toThrow(TransformError);
    }
  });
  it('the whitelist contains no execution primitive', () => {
    for (const bad of ['eval', 'Function', 'exec', 'require', 'import', 'vm']) {
      expect(ALLOWED_FUNCTIONS).not.toContain(bad);
    }
  });
  it('rejects a ReDoS-shaped regex at save time', () => {
    expect(() => assertSafeRegex('(a+)+$')).toThrow(TransformError);
    expect(() => assertSafeRegex('([a-z]*)*')).toThrow(TransformError);
    expect(() => assertSafeRegex('^\\d{5}$')).not.toThrow();
  });
});

describe('money direction — the 100x inversion trap', () => {
  it('flags multiply(100) on a monetary target as a probable inversion', () => {
    expect(() => validateTemplate({
      name: 'x',
      rules: [{
        target: 'lines[].unitPrice', source: 'items[].cents',
        transform: [{ fn: 'multiply', arg: 100 }, { fn: 'toDecimalString', arg: 2 }],
      }],
    })).toThrow(/divide\(100\)/);
  });
  it('accepts divide(100) — cents to decimal', () => {
    expect(() => validateTemplate({
      name: 'x',
      rules: [{
        target: 'lines[].unitPrice', source: 'items[].cents',
        transform: [{ fn: 'divide', arg: 100 }, { fn: 'toDecimalString', arg: 2 }],
      }],
    })).not.toThrow();
  });
  it('requires toDecimalString to terminate a monetary chain', () => {
    expect(() => validateTemplate({
      name: 'x',
      rules: [{ target: 'lines[].totalPrice', source: 'total', transform: [{ fn: 'divide', arg: 100 }] }],
    })).toThrow(/must end with toDecimalString/);
  });
  it('recognises monetary targets', () => {
    expect(isMonetaryTarget('lines[].unitPrice')).toBe(true);
    expect(isMonetaryTarget('summaries[].taxAmount')).toBe(true);
    expect(isMonetaryTarget('buyer.name')).toBe(false);
  });
});

describe('applying a template', () => {
  const tpl = validateTemplate({
    name: 'crm-x',
    rules: [
      { target: 'number', source: 'doc.id', transform: [{ fn: 'prefix', arg: 'INV-' }] },
      // An explicit format is mandatory: "01/02/2026" is 1 February here,
      // and 2 January under MM/DD. See the dateFormat suite below.
      { target: 'date', source: 'doc.issued', transform: [{ fn: 'dateFormat', arg: 'DD/MM/YYYY' }] },
      { target: 'currency', literal: 'EUR' },
      { target: 'buyer.name', source: 'customer.company', required: true },
      {
        target: 'lines[].unitPrice', source: 'items[].price_cents',
        transform: [{ fn: 'divide', arg: 100 }, { fn: 'toDecimalString', arg: 2 }],
      },
      { target: 'lines[].description', source: 'items[].label' },
    ],
  });

  it('maps scalars, literals and nested paths', () => {
    const out = applyTemplate(tpl, {
      doc: { id: '42', issued: '2026-09-01T10:00:00Z' },
      customer: { company: 'Acme S.p.A.' },
      items: [],
    });
    expect(out['number']).toBe('INV-42');
    expect(out['date']).toBe('2026-09-01');
    expect(out['currency']).toBe('EUR');
    expect((out['buyer'] as Record<string, unknown>)['name']).toBe('Acme S.p.A.');
  });

  it('converts integer cents to a FatturaPA decimal string', () => {
    const out = applyTemplate(tpl, {
      doc: { id: '1', issued: '2026-09-01' }, customer: { company: 'X' },
      items: [{ price_cents: 123456, label: 'Servizio' }],
    });
    const lines = out['lines'] as Array<Record<string, unknown>>;
    expect(lines[0]!['unitPrice']).toBe('1234.56');      // not 12345600
    expect(lines[0]!['description']).toBe('Servizio');
  });

  it('errors name BOTH the CRM source path and the canonical target', () => {
    try {
      applyTemplate(tpl, { doc: { id: '1', issued: '2026-09-01' }, customer: {}, items: [] });
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as TransformError;
      expect(err.sourcePath).toBe('customer.company');   // what the CRM sent
      expect(err.targetPath).toBe('buyer.name');         // what PASSO expects
    }
  });

  it('caps a hostile array', () => {
    const items = Array.from({ length: LIMITS.maxArrayItems + 1 }, () => ({ price_cents: 1, label: 'x' }));
    expect(() => applyTemplate(tpl, {
      doc: { id: '1', issued: '2026-09-01' }, customer: { company: 'X' }, items,
    })).toThrow(/limit is/);
  });
});

/**
 * XFORM-010 — explicit date formats.
 *
 * `new Date("01/02/2026")` reads it as 2 January (US); an Italian CRM means
 * 1 February. The invoice then carries the wrong fiscal date, silently, and
 * nothing downstream can detect it. Guessing is not an option here.
 */
describe('dateFormat', () => {
  const run = (value: string, fmt?: string) =>
    applyTemplate(validateTemplate({
      name: 't', rules: [{ target: 'date', source: 'd',
        transform: [{ fn: 'dateFormat', ...(fmt ? { arg: fmt } : {}) }] }],
    }), { d: value })['date'];

  it('reads the SAME input differently under DD/MM and MM/DD', () => {
    expect(run('01/02/2026', 'DD/MM/YYYY')).toBe('2026-02-01');   // 1 February
    expect(run('01/02/2026', 'MM/DD/YYYY')).toBe('2026-01-02');   // 2 January
  });

  it('REFUSES to guess when no format is given', () => {
    expect(() => run('01/02/2026')).toThrow(/explicit source format/);
  });

  it('passes an ISO date through untouched', () => {
    expect(run('2026-02-01', 'DD/MM/YYYY')).toBe('2026-02-01');
  });

  it('supports the common separators and compact form', () => {
    expect(run('01-02-2026', 'DD-MM-YYYY')).toBe('2026-02-01');
    expect(run('01.02.2026', 'DD.MM.YYYY')).toBe('2026-02-01');
    expect(run('20260201', 'YYYYMMDD')).toBe('2026-02-01');
  });

  it('rejects a value that does not match the declared format', () => {
    expect(() => run('2026-02-01x', 'DD/MM/YYYY')).toThrow(/does not match/);
  });

  it('rejects an impossible date the regex would otherwise accept', () => {
    expect(() => run('31/02/2026', 'DD/MM/YYYY')).toThrow(/not a real date/);
  });

  it('names the supported formats when given an unknown one', () => {
    expect(() => run('01/02/2026', 'DD MMM YYYY')).toThrow(/Supported:/);
  });
});

describe('replace, lookup and boolean', () => {
  const run = (fn: string, arg: string, value: unknown) =>
    applyTemplate(validateTemplate({
      name: 't', rules: [{ target: 'number', source: 'v', transform: [{ fn, arg }] }],
    }), { v: value })['number'];

  it('replace is LITERAL, not a regex', () => {
    expect(run('replace', 'Srl|S.r.l.', 'Acme Srl')).toBe('Acme S.r.l.');
    // A regex engine would treat "." as a wildcard; this must not.
    expect(run('replace', '.|-', 'a.b.c')).toBe('a-b-c');
  });

  it('replace requires the search|replacement form', () => {
    expect(() => run('replace', 'nosep', 'x')).toThrow(/search\|replacement/);
  });

  it('lookup maps a CRM code to a FatturaPA enum', () => {
    expect(run('lookup', 'cash:MP01,transfer:MP05', 'transfer')).toBe('MP05');
  });

  /**
   * Passing an unmapped value through would produce an invoice SdI rejects —
   * and NS is terminal, so the cost of "just forward it" is a reissued invoice.
   */
  it('lookup FAILS on an unmapped value rather than forwarding it', () => {
    expect(() => run('lookup', 'cash:MP01', 'bitcoin')).toThrow(/no mapping for "bitcoin"/);
  });

  it('boolean produces SI/NO, not true/false', () => {
    // A JSON true serialises to "true", which is schema-invalid.
    for (const t of ['true', '1', 'yes', 'si', true]) expect(run('boolean', '', t)).toBe('SI');
    for (const f of ['false', '0', 'no', false]) expect(run('boolean', '', f)).toBe('NO');
  });

  it('boolean refuses a value it cannot read', () => {
    expect(() => run('boolean', '', 'maybe')).toThrow(/cannot read/);
  });
});
