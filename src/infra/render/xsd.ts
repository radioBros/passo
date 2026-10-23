import libxml from 'libxmljs2';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * XSD validation — MANDATORY and non-skippable before transmission
 * (compliance_register_spec R1). An invoice that fails here must never reach SdI.
 *
 * One schema serves both B2B and B2G: Schema_VFPR12_v1.2.3.xsd and
 * Schema_VFPA12_V1.2.3.xsd are BYTE-IDENTICAL (same md5). B2B/B2G differ only by
 * the FormatoTrasmissione value inside the document, never by schema.
 * See development/research/xsd_extraction_research.md finding 1.
 *
 * Target namespace is .../fatture/v1.2 — v1.2, NOT v1.2.3. The namespace is
 * stable across patch revisions; hardcoding v1.2.3 causes universal rejection.
 */

const XSD_DIR = process.env['PASSO_XSD_DIR'] ?? 'assets/xsd';

const ORDINARY = 'Schema_VFPR12_v1.2.3.xsd';
const SIMPLIFIED = 'Schema_VFSM10v_1.0.2.xsd';
const MESSAGGI = 'MessaggiTypes_v1.1.xsd';

/**
 * Namespaces are READ FROM THE SCHEMA, never transcribed (XML-002).
 *
 * The distinction is not pedantry: the invoice namespace ends `/v1.2` while the
 * schema FILE is named `v1.2.3`, and writing the file's version into the
 * namespace produces a document SdI rejects universally. A constant typed from
 * memory is exactly how that error gets made, and it cannot be caught by any
 * test that shares the same assumption.
 *
 * Reading the value means swapping in a different schema either works or fails
 * loudly at boot — it can never silently disagree with what we transmit.
 */
function targetNamespaceOf(file: string): string {
  const p = path.join(XSD_DIR, file);
  if (!existsSync(p)) {
    // ERR_XSD_UNAVAILABLE: the schema is missing from the image, which blocks
    // every submission. A deployment fault, not a caller error.
    throw new XsdError(
      `ERR_XSD_UNAVAILABLE: schema not bundled: ${file} — deployment fault, blocks all submission`);
  }
  const m = /targetNamespace\s*=\s*"([^"]+)"/.exec(readFileSync(p, 'utf8'));
  if (!m?.[1]) {
    throw new XsdError(`${file} declares no targetNamespace — cannot determine the invoice namespace`);
  }
  return m[1];
}

export const INVOICE_NS = targetNamespaceOf(ORDINARY);
export const MESSAGGI_NS = targetNamespaceOf(MESSAGGI);

export class XsdError extends Error {
  readonly details: string[];
  constructor(message: string, details: string[] = []) { super(message); this.details = details; }
}

const cache = new Map<string, libxml.Document>();

function loadSchema(file: string): libxml.Document {
  const hit = cache.get(file);
  if (hit) return hit;
  const p = path.join(XSD_DIR, file);
  if (!existsSync(p)) {
    // ERR_XSD_UNAVAILABLE: the schema is missing from the image, which blocks
    // every submission. A deployment fault, not a caller error.
    throw new XsdError(
      `ERR_XSD_UNAVAILABLE: schema not bundled: ${file} — deployment fault, blocks all submission`);
  }
  // The FatturaPA XSDs <xs:import> the W3C xmldsig schema. Upstream that import
  // points at a w3.org URL; we rewrote it to a VENDORED relative path so schema
  // compilation never touches the network (assets/xsd/xmldsig-core-schema.xsd).
  // libxml resolves the relative import against the document's baseUrl, so the
  // baseUrl must be the schema directory or compilation fails with the unhelpful
  // "Invalid XSD schema".
  const doc = libxml.parseXml(readFileSync(p, 'utf8'), {
    baseUrl: XSD_DIR.endsWith('/') ? XSD_DIR : `${XSD_DIR}/`,
    nonet: true,
    dtdload: false,
  });
  cache.set(file, doc);
  return doc;
}

export interface ValidationResult { valid: boolean; errors: string[] }

/** Validate generated FatturaPA XML. `simplified` selects VFSM10 (Phase 2). */
export function validateInvoiceXml(xml: string, simplified = false): ValidationResult {
  const schema = loadSchema(simplified ? SIMPLIFIED : ORDINARY);
  let doc: libxml.Document;
  try {
    doc = libxml.parseXml(xml, { nonet: true, dtdload: false, noent: false });
  } catch (e) {
    return { valid: false, errors: [`not well-formed XML: ${(e as Error).message}`] };
  }
  const ok = doc.validate(schema);
  return ok
    ? { valid: true, errors: [] }
    : { valid: false, errors: (doc.validationErrors ?? []).map((e) => String(e).trim()) };
}

/** Assert-style wrapper for the submission pipeline. */
export function assertValidInvoiceXml(xml: string, simplified = false): void {
  const r = validateInvoiceXml(xml, simplified);
  if (!r.valid) {
    throw new XsdError(
      `generated XML failed XSD validation (${r.errors.length} error(s))`, r.errors,
    );
  }
}
