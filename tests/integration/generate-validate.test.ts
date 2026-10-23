import { describe, it, expect } from 'vitest';
import { InvoiceSchema } from '../../src/domain/invoice/model.ts';
import { generateInvoiceXml, invoiceFileName, type TransmissionMeta } from '../../src/domain/invoice/generator.ts';
import { validateInvoiceXml } from '../../src/infra/render/xsd.ts';
import { renderInvoice } from '../../src/infra/render/xslt.ts';

const meta: TransmissionMeta = {
  transmitterCountry: 'IT', transmitterCode: '01234567890', progressivoInvio: '00001',
};

const b2b = {
  documentType: 'TD01', number: '2026/0042', date: '2026-09-01', currency: 'EUR',
  format: 'FPR12', recipientCode: 'ABC1234',
  seller: {
    vatId: { country: 'IT', code: '01234567890' }, name: 'Fornitore S.r.l.',
    taxRegime: 'RF01',
    address: { street: 'Via Roma', streetNumber: '1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
  },
  buyer: {
    vatId: { country: 'IT', code: '09876543210' }, name: 'Cliente S.p.A.',
    address: { street: 'Via Milano', postalCode: '00100', city: 'Roma', province: 'RM', country: 'IT' },
  },
  lines: [{
    lineNumber: 1, description: 'Consulenza', quantity: '10.00', unitOfMeasure: 'ora',
    unitPrice: '100.00', totalPrice: '1000.00', vatRate: '22.00',
  }],
  summaries: [{ vatRate: '22.00', taxableAmount: '1000.00', taxAmount: '220.00', vatCollectability: 'I' }],
  payment: { conditions: 'TP02', method: 'MP05', dueDate: '2026-10-01', amount: '1220.00', iban: 'IT60X0542811101000000123456' },
};

describe('generate -> XSD validate (the mandatory gate)', () => {
  it('B2B invoice passes official XSD validation', () => {
    const inv = InvoiceSchema.parse(b2b);
    const xml = generateInvoiceXml(inv, meta);
    const r = validateInvoiceXml(xml);
    if (!r.valid) console.error(r.errors.slice(0, 6));
    expect(r.valid).toBe(true);
  });

  it('B2G invoice with 6-char IPA and CIG/CUP passes XSD', () => {
    const inv = InvoiceSchema.parse({
      ...b2b, format: 'FPA12', recipientCode: 'UF1234',
      cig: '1234567890', cup: 'ABC123', purchaseOrderId: 'PO-9',
    });
    const r = validateInvoiceXml(generateInvoiceXml(inv, meta));
    if (!r.valid) console.error(r.errors.slice(0, 6));
    expect(r.valid).toBe(true);
  });

  it('exempt line with Natura passes XSD', () => {
    const inv = InvoiceSchema.parse({
      ...b2b,
      lines: [{ lineNumber: 1, description: 'Esente', unitPrice: '500.00', totalPrice: '500.00', vatRate: '0.00', nature: 'N4' }],
      summaries: [{ vatRate: '0.00', nature: 'N4', taxableAmount: '500.00', taxAmount: '0.00', lawReference: 'Art. 10 DPR 633/72' }],
    });
    const r = validateInvoiceXml(generateInvoiceXml(inv, meta));
    if (!r.valid) console.error(r.errors.slice(0, 6));
    expect(r.valid).toBe(true);
  });

  it('credit note TD04 with negative amounts passes XSD', () => {
    const inv = InvoiceSchema.parse({
      ...b2b, documentType: 'TD04',
      lines: [{ lineNumber: 1, description: 'Nota di credito', unitPrice: '-100.00', totalPrice: '-100.00', vatRate: '22.00' }],
      summaries: [{ vatRate: '22.00', taxableAmount: '-100.00', taxAmount: '-22.00' }],
      payment: undefined,
    });
    const r = validateInvoiceXml(generateInvoiceXml(inv, meta));
    if (!r.valid) console.error(r.errors.slice(0, 6));
    expect(r.valid).toBe(true);
  });

  it('emits the correct namespace (v1.2, not v1.2.3)', () => {
    const xml = generateInvoiceXml(InvoiceSchema.parse(b2b), meta);
    expect(xml).toContain('docs/xsd/fatture/v1.2"');
    expect(xml).not.toContain('fatture/v1.2.3');
  });

  it('pads money with the mandatory trailing .00', () => {
    const inv = InvoiceSchema.parse({
      ...b2b,
      lines: [{ lineNumber: 1, description: 'X', unitPrice: '1000', totalPrice: '1000', vatRate: '22' }],
      summaries: [{ vatRate: '22', taxableAmount: '1000', taxAmount: '220' }],
      payment: undefined,
    });
    const xml = generateInvoiceXml(inv, meta);
    expect(xml).toContain('<PrezzoTotale>1000.00</PrezzoTotale>');
    expect(xml).toContain('<AliquotaIVA>22.00</AliquotaIVA>');
    expect(xml).not.toMatch(/<AliquotaIVA>22<\//);
  });

  it('filename follows {IdPaese}{IdCodice}_{Progressivo}.xml', () => {
    expect(invoiceFileName(meta)).toBe('IT01234567890_00001.xml');
    expect(invoiceFileName(meta, true)).toBe('IT01234567890_00001.xml.p7m');
  });

  it('generated invoice renders via the official AdE stylesheet', async () => {
    const xml = generateInvoiceXml(InvoiceSchema.parse(b2b), meta);
    const html = await renderInvoice(xml, 'FPR12');
    const text = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
    expect(text).toContain('2026/0042');
    expect(text).toContain('Fornitore S.r.l.');
  });
});

/**
 * XML-015 / XML-019 — contract references and attachments.
 *
 * Both are XSD-validated before submission, and element ORDER is fixed by the
 * schema: `Allegati` out of place fails validation rather than reaching SdI.
 */
describe('stamp duty (DatiBollo)', () => {
  const withBollo = (over: Record<string, unknown> = {}) =>
    ({ ...b2b, stampDuty: { virtual: true, amount: '2.00' }, ...over });

  it('is emitted right after Numero and passes XSD, for FPR12 and FPA12', () => {
    for (const fmt of [{}, { format: 'FPA12', recipientCode: 'UFY9MH' }]) {
      const xml = generateInvoiceXml(InvoiceSchema.parse(withBollo(fmt)), meta);
      expect(xml).toMatch(/<Numero>2026\/0042<\/Numero>\s*<DatiBollo>\s*<BolloVirtuale>SI<\/BolloVirtuale>\s*<ImportoBollo>2\.00<\/ImportoBollo>\s*<\/DatiBollo>/);
      expect(validateInvoiceXml(xml).valid).toBe(true);
    }
  });

  it('formats the amount to 2 decimals, half up', () => {
    const xml = generateInvoiceXml(InvoiceSchema.parse(withBollo({ stampDuty: { virtual: true, amount: '2.005' } })), meta);
    expect(xml).toContain('<ImportoBollo>2.01</ImportoBollo>');
  });

  it('is absent when not sent', () => {
    expect(generateInvoiceXml(InvoiceSchema.parse(b2b), meta)).not.toContain('DatiBollo');
  });

  it.each([
    ['missing amount', { virtual: true }],
    ['virtual false', { virtual: false, amount: '2.00' }],
    ['negative amount', { virtual: true, amount: '-2.00' }],
    ['unknown key', { virtual: true, amount: '2.00', extra: 1 }],
  ])('rejects %s', (_n, stampDuty) => {
    expect(InvoiceSchema.safeParse(withBollo({ stampDuty })).success).toBe(false);
  });
});

describe('contract references and attachments', () => {
  it('a contract reference passes XSD', () => {
    const xml = generateInvoiceXml(
      InvoiceSchema.parse(({ ...b2b, ...({ format: 'FPA12', recipientCode: 'ABC123',
        contractId: 'CTR-2026-1', cig: '1234567890' }) })), meta);
    expect(xml).toContain('<DatiContratto>');
    expect(validateInvoiceXml(xml).valid).toBe(true);
  });

  it('a convention reference passes XSD', () => {
    const xml = generateInvoiceXml(
      InvoiceSchema.parse(({ ...b2b, ...({ format: 'FPA12', recipientCode: 'ABC123',
        conventionId: 'CNV-9' }) })), meta);
    expect(xml).toContain('<DatiConvenzione>');
    expect(validateInvoiceXml(xml).valid).toBe(true);
  });

  it('an ATTACHMENT passes XSD and lands last in the body', () => {
    const xml = generateInvoiceXml(
      InvoiceSchema.parse(({ ...b2b, ...({
        attachments: [{ name: 'nota.pdf', format: 'PDF',
                        description: 'Nota di accompagnamento',
                        content: Buffer.from('hello').toString('base64') }],
      }) })), meta);
    expect(xml).toContain('<NomeAttachment>nota.pdf<');
    expect(validateInvoiceXml(xml).valid).toBe(true);
    // Element order is fixed by the XSD: Allegati follows DatiBeniServizi.
    expect(xml.indexOf('<Allegati>')).toBeGreaterThan(xml.indexOf('<DatiBeniServizi>'));
  });

  it('carries MULTIPLE attachments', () => {
    const b64 = Buffer.from('x').toString('base64');
    const xml = generateInvoiceXml(
      InvoiceSchema.parse(({ ...b2b, ...({
        attachments: [{ name: 'a.pdf', content: b64 }, { name: 'b.pdf', content: b64 }],
      }) })), meta);
    expect(xml.match(/<Allegati>/g)).toHaveLength(2);
    expect(validateInvoiceXml(xml).valid).toBe(true);
  });

  it('REFUSES a non-base64 attachment before it can corrupt the XML', () => {
    expect(() => InvoiceSchema.parse(({ ...b2b, ...({
      attachments: [{ name: 'a.pdf', content: 'not base64!!' }],
    }) }))).toThrow();
  });

  /**
   * The attachment travels inside the invoice, so an oversized one makes the
   * WHOLE submission undeliverable — the failure surfaces at the channel, long
   * after the CRM believed it was accepted.
   */
  it('REFUSES attachments that would breach the 30MB channel limit', () => {
    const huge = 'A'.repeat(28 * 1024 * 1024);   // ~21MB decoded
    expect(() => InvoiceSchema.parse(({ ...b2b, ...({
      attachments: [{ name: 'huge.pdf', content: huge }],
    }) }))).toThrow(/30MB channel limit/);
  });
});

/**
 * XML-024 — negative fixtures and mutation testing.
 *
 * The positive tests prove the generator can produce a valid document. These
 * prove the XSD gate actually REJECTS an invalid one — without them, a
 * validator that returned `valid: true` unconditionally would pass every test
 * above, and every malformed invoice would reach the tax authority.
 */
describe('XSD gate rejects invalid documents', () => {
  const good = () => generateInvoiceXml(InvoiceSchema.parse({ ...b2b }), meta);

  it('rejects a document with the WRONG namespace', () => {
    const bad = good().replace(
      'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2',
      'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2.3');
    // v1.2.3 is the FILE version; using it as the namespace is rejected
    // universally by SdI, so the gate must catch it here.
    expect(validateInvoiceXml(bad).valid).toBe(false);
  });

  it('rejects money written as a bare integer', () => {
    const bad = good().replace('<PrezzoUnitario>100.00<', '<PrezzoUnitario>100<');
    expect(validateInvoiceXml(bad).valid).toBe(false);
  });

  it('rejects a missing MANDATORY element', () => {
    const bad = good().replace(/<ProgressivoInvio>[^<]*<\/ProgressivoInvio>/, '');
    expect(validateInvoiceXml(bad).valid).toBe(false);
  });

  it('rejects an out-of-order element — the XSD fixes sequence', () => {
    const xml = good();
    const m = /<DatiTrasmissione>[\s\S]*?<\/DatiTrasmissione>/.exec(xml)!;
    const bad = xml.replace(m[0], '') .replace('</FatturaElettronicaHeader>', `${m[0]}</FatturaElettronicaHeader>`);
    expect(validateInvoiceXml(bad).valid).toBe(false);
  });

  it('rejects an invalid TipoDocumento', () => {
    const bad = good().replace('<TipoDocumento>TD01<', '<TipoDocumento>TD99<');
    expect(validateInvoiceXml(bad).valid).toBe(false);
  });

  it('rejects a VAT rate outside the permitted range', () => {
    const bad = good().replace(/<AliquotaIVA>22\.00<\/AliquotaIVA>/g, '<AliquotaIVA>999.00</AliquotaIVA>');
    expect(validateInvoiceXml(bad).valid).toBe(false);
  });

  it('rejects malformed XML outright rather than throwing', () => {
    const r = validateInvoiceXml('<not-even-close>');
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('REPORTS what was wrong — a bare false cannot be acted on', () => {
    const bad = good().replace('<TipoDocumento>TD01<', '<TipoDocumento>TD99<');
    expect(validateInvoiceXml(bad).errors.join(' ')).toMatch(/TipoDocumento|TD99/);
  });
});
