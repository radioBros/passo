import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { validateInvoiceXml, assertValidInvoiceXml, XsdError, INVOICE_NS, MESSAGGI_NS } from '../../src/infra/render/xsd.ts';

describe('XSD validation gate', () => {
  it('rejects malformed XML', () => {
    const r = validateInvoiceXml('<not-closed>');
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatch(/not well-formed/);
  });

  it('rejects a well-formed document that is not a FatturaElettronica', () => {
    const r = validateInvoiceXml('<?xml version="1.0"?><Foo><Bar/></Foo>');
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it('rejects the WRONG namespace (v1.2.3 instead of v1.2)', () => {
    const wrong = `<?xml version="1.0"?><p:FatturaElettronica
      xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2.3"
      versione="FPR12"></p:FatturaElettronica>`;
    expect(validateInvoiceXml(wrong).valid).toBe(false);
  });

  it('compiles the schema without network access (vendored xmldsig import)', () => {
    // Upstream the XSD imports xmldsig-core-schema.xsd from w3.org. If that
    // import is not vendored and rewritten, schema compilation throws
    // "Invalid XSD schema" and every submission is blocked.
    const r = validateInvoiceXml('<?xml version="1.0"?><Foo/>');
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);   // reached validation, not a load failure
  });

  it('exposes the correct namespace constant', () => {
    expect(INVOICE_NS).toBe('http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2');
    expect(INVOICE_NS).not.toContain('v1.2.3');
  });

  it('assert wrapper throws XsdError carrying details', () => {
    try {
      assertValidInvoiceXml('<?xml version="1.0"?><Foo/>');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(XsdError);
      expect((e as XsdError).details.length).toBeGreaterThan(0);
    }
  });
});

/**
 * XML-002 — the namespace is READ FROM THE SCHEMA, never transcribed.
 *
 * The invoice namespace ends `/v1.2` while the schema file is named `v1.2.3`.
 * Writing the file's version into the namespace yields a document SdI rejects
 * universally, and no test that shares the same wrong assumption can catch it.
 * Deriving the value makes a schema swap fail loudly instead of silently
 * disagreeing with what we transmit.
 */
describe('namespace derivation', () => {
  const read = (f: string) =>
    readFileSync(`${process.env['PASSO_XSD_DIR'] ?? 'assets/xsd'}/${f}`, 'utf8');

  it('INVOICE_NS matches the schema file byte for byte', () => {
    const declared = /targetNamespace\s*=\s*"([^"]+)"/
      .exec(read('Schema_VFPR12_v1.2.3.xsd'))?.[1];
    expect(INVOICE_NS).toBe(declared);
  });

  it('MESSAGGI_NS matches its schema file', () => {
    const declared = /targetNamespace\s*=\s*"([^"]+)"/
      .exec(read('MessaggiTypes_v1.1.xsd'))?.[1];
    expect(MESSAGGI_NS).toBe(declared);
  });

  it('is /v1.2 — NOT the v1.2.3 of the filename', () => {
    expect(INVOICE_NS).toMatch(/\/fatture\/v1\.2$/);
    expect(INVOICE_NS).not.toContain('1.2.3');
  });

  it('B2B and B2G share one namespace — they differ only by FormatoTrasmissione', () => {
    const b2b = /targetNamespace\s*=\s*"([^"]+)"/.exec(read('Schema_VFPR12_v1.2.3.xsd'))?.[1];
    const b2g = /targetNamespace\s*=\s*"([^"]+)"/.exec(read('Schema_VFPA12_V1.2.3.xsd'))?.[1];
    expect(b2b).toBe(b2g);
  });
});
