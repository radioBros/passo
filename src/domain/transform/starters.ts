import type { Template } from './engine.ts';

/**
 * Verified starter templates (XFORM-018).
 *
 * "Verified" means these were written against the canonical model in this
 * repository and are exercised by tests — not that they match any particular
 * CRM's output. Nobody has inspected Wave's, Zoho's or any other CRM's real JSON, so
 * no template claiming to map them ships here: a starter that is wrong is worse
 * than none, because it looks authoritative and produces a plausible invoice
 * with the wrong values.
 *
 * These are teaching examples. The money conversion is the point of two of
 * them, because that is the mistake that actually reaches the tax authority.
 */

export interface StarterTemplate {
  key: string;
  name: string;
  description: string;
  /** What shape of CRM output this is for. */
  suits: string;
  template: Template;
}

/** Shared party and line structure, so each starter shows only its difference. */
const commonRules = (moneyChain: Array<{ fn: string; arg?: string | number }>) => [
  { target: 'documentType', literal: 'TD01' },
  { target: 'currency', literal: 'EUR' },
  { target: 'format', literal: 'FPR12' },
  { target: 'seller.vatId.country', literal: 'IT' },
  { target: 'seller.address.country', literal: 'IT' },
  { target: 'buyer.vatId.country', literal: 'IT' },
  { target: 'buyer.address.country', literal: 'IT' },
  { target: 'lines[].unitPrice', source: 'lines[].unitPrice', transform: moneyChain },
  { target: 'lines[].totalPrice', source: 'lines[].totalPrice', transform: moneyChain },
];

export const STARTER_TEMPLATES: readonly StarterTemplate[] = Object.freeze([
  {
    key: 'passthrough',
    name: 'Passthrough (identity)',
    description:
      'For a CRM already emitting the canonical PASSO shape. Maps each field to ' +
      'itself — the simplest working example, and a starting point to edit.',
    suits: 'A CRM you control, emitting PASSO JSON directly',
    template: {
      name: 'passthrough',
      sourceFormat: 'passo/canonical',
      rules: [
        { target: 'documentType', source: 'documentType' },
        { target: 'number', source: 'number', required: true },
        { target: 'date', source: 'date', required: true },
        { target: 'currency', source: 'currency' },
        { target: 'format', source: 'format' },
        { target: 'recipientCode', source: 'recipientCode', required: true },
        { target: 'seller.name', source: 'seller.name', required: true },
        { target: 'seller.taxRegime', source: 'seller.taxRegime', required: true },
        { target: 'seller.vatId.country', source: 'seller.vatId.country' },
        { target: 'seller.vatId.code', source: 'seller.vatId.code' },
        { target: 'buyer.name', source: 'buyer.name', required: true },
        { target: 'buyer.vatId.country', source: 'buyer.vatId.country' },
        { target: 'buyer.vatId.code', source: 'buyer.vatId.code' },
        { target: 'lines[].lineNumber', source: 'lines[].lineNumber' },
        { target: 'lines[].description', source: 'lines[].description' },
        { target: 'lines[].unitPrice', source: 'lines[].unitPrice',
          transform: [{ fn: 'toDecimalString', arg: 2 }] },
        { target: 'lines[].totalPrice', source: 'lines[].totalPrice',
          transform: [{ fn: 'toDecimalString', arg: 2 }] },
        { target: 'lines[].vatRate', source: 'lines[].vatRate',
          transform: [{ fn: 'toDecimalString', arg: 2 }] },
      ],
    },
  },
  {
    key: 'generic-cents',
    name: 'Integer cents',
    description:
      'For a CRM storing money as integer cents. Demonstrates divide(100) — the ' +
      'conversion that goes wrong most often, and wrongly by 10,000x when someone ' +
      'reaches for multiply(100) instead.',
    suits: 'Stripe-style integer minor units (100000 meaning €1000.00)',
    template: {
      name: 'generic-cents',
      sourceFormat: 'generic/cents',
      rules: [
        { target: 'number', source: 'invoice_number', required: true },
        { target: 'date', source: 'invoice_date', required: true,
          transform: [{ fn: 'dateFormat', arg: 'YYYY-MM-DD' }] },
        { target: 'recipientCode', source: 'recipient_code', required: true },
        { target: 'seller.name', source: 'seller.name', required: true },
        { target: 'seller.taxRegime', source: 'seller.tax_regime' },
        { target: 'seller.vatId.code', source: 'seller.vat_number' },
        { target: 'buyer.name', source: 'buyer.name', required: true },
        { target: 'buyer.vatId.code', source: 'buyer.vat_number' },
        { target: 'lines[].lineNumber', source: 'lines[].position' },
        { target: 'lines[].description', source: 'lines[].description' },
        { target: 'lines[].vatRate', source: 'lines[].vat_percent',
          transform: [{ fn: 'toDecimalString', arg: 2 }] },
        ...commonRules([{ fn: 'divide', arg: 100 }, { fn: 'toDecimalString', arg: 2 }])
          .filter((r) => r.target.startsWith('lines[]') || r.target.includes('country')
                      || ['documentType', 'currency', 'format'].includes(r.target)),
      ],
    },
  },
  {
    key: 'generic-decimal',
    name: 'Decimal money',
    description:
      'For a CRM already storing decimal amounts. Shows that they still need ' +
      'toDecimalString: FatturaPA wants "1000.00" and a JSON number serialises ' +
      'as 1000, which is schema-invalid.',
    suits: 'Decimal or string amounts such as 1000.5 or "1000.5"',
    template: {
      name: 'generic-decimal',
      sourceFormat: 'generic/decimal',
      rules: [
        { target: 'number', source: 'invoice_number', required: true },
        { target: 'date', source: 'invoice_date', required: true,
          transform: [{ fn: 'dateFormat', arg: 'DD/MM/YYYY' }] },
        { target: 'recipientCode', source: 'recipient_code', required: true },
        { target: 'seller.name', source: 'seller.name', required: true },
        { target: 'seller.taxRegime', source: 'seller.tax_regime' },
        { target: 'seller.vatId.code', source: 'seller.vat_number' },
        { target: 'buyer.name', source: 'buyer.name', required: true },
        { target: 'buyer.vatId.code', source: 'buyer.vat_number' },
        { target: 'lines[].lineNumber', source: 'lines[].position' },
        { target: 'lines[].description', source: 'lines[].description' },
        { target: 'lines[].vatRate', source: 'lines[].vat_percent',
          transform: [{ fn: 'toDecimalString', arg: 2 }] },
        ...commonRules([{ fn: 'toDecimalString', arg: 2 }])
          .filter((r) => r.target.startsWith('lines[]') || r.target.includes('country')
                      || ['documentType', 'currency', 'format'].includes(r.target)),
      ],
    },
  },
]);

export const starterByKey = (key: string): StarterTemplate | undefined =>
  STARTER_TEMPLATES.find((t) => t.key === key);
