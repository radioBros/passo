import { z } from 'zod';
import {
  TIPODOCUMENTO, NATURA, REGIMEFISCALE, MODALITAPAGAMENTO,
  CONDIZIONIPAGAMENTO, ESIGIBILITAIVA, FORMATOTRASMISSIONE,
} from '../../shared/types/fatturapa-enums.ts';

/**
 * Canonical PASSO invoice model.
 *
 * Deliberately NOT a mirror of FatturaPA: callers send a clean shape and the
 * generator maps it. Transmission fields PASSO owns (ProgressivoInvio,
 * IdTrasmittente, filename) are never accepted from the caller.
 *
 * Money is a DECIMAL STRING everywhere. See shared/util/money.ts for why.
 */

const decimalString = z.string().regex(/^-?\d{1,11}(\.\d{1,8})?$/, 'must be a decimal string');
const nonNegDecimal = z.string().regex(/^\d{1,11}(\.\d{1,8})?$/, 'must be a non-negative decimal string');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD (a date, not a datetime)');

export const AddressSchema = z.object({
  street: z.string().min(1).max(60),
  streetNumber: z.string().max(8).optional(),
  postalCode: z.string().regex(/^\d{5}$/),
  city: z.string().min(1).max(60),
  province: z.string().regex(/^[A-Z]{2}$/).optional(),
  country: z.string().regex(/^[A-Z]{2}$/).default('IT'),
}).strict();

export const VatIdSchema = z.object({
  // IdPaese and IdCodice are SEPARATE fields. The "IT" prefix belongs in
  // country and must never be embedded in code.
  country: z.string().regex(/^[A-Z]{2}$/),
  code: z.string().min(1).max(28).regex(/^[^A-Z]{0,0}[A-Za-z0-9]+$/, 'digits/letters only, no country prefix'),
}).strict();

export const PartySchema = z.object({
  vatId: VatIdSchema.optional(),
  taxCode: z.string().min(11).max(16).optional(),
  name: z.string().min(1).max(80).optional(),
  firstName: z.string().min(1).max(60).optional(),
  lastName: z.string().min(1).max(60).optional(),
  address: AddressSchema,
  taxRegime: z.enum(REGIMEFISCALE).optional(),
}).strict().refine(
  (p) => (p.name ? !p.firstName && !p.lastName : !!(p.firstName && p.lastName)),
  { message: 'provide either name (Denominazione) or firstName+lastName, never both' },
);

export const LineItemSchema = z.object({
  lineNumber: z.number().int().positive(),
  description: z.string().min(1).max(1000),
  quantity: nonNegDecimal.optional(),
  unitOfMeasure: z.string().max(10).optional(),
  unitPrice: decimalString,
  totalPrice: decimalString,
  vatRate: nonNegDecimal,
  nature: z.enum(NATURA).optional(),
}).strict().refine(
  (l) => (Number(l.vatRate) === 0 ? !!l.nature : true),
  { message: 'Natura is required when vatRate is 0' },
).refine(
  (l) => (l.nature ? Number(l.vatRate) === 0 : true),
  { message: 'Natura may only be set when vatRate is 0' },
);

export const TaxSummarySchema = z.object({
  vatRate: nonNegDecimal,
  nature: z.enum(NATURA).optional(),
  taxableAmount: decimalString,
  taxAmount: decimalString,
  vatCollectability: z.enum(ESIGIBILITAIVA).optional(),
  lawReference: z.string().max(100).optional(),
}).strict();

export const PaymentSchema = z.object({
  conditions: z.enum(CONDIZIONIPAGAMENTO),
  method: z.enum(MODALITAPAGAMENTO),
  dueDate: isoDate.optional(),
  amount: decimalString.optional(),
  iban: z.string().regex(/^[A-Z]{2}\d{2}[A-Za-z0-9]{11,30}$/).optional(),
}).strict();

export const InvoiceSchema = z.object({
  documentType: z.enum(TIPODOCUMENTO).default('TD01'),
  number: z.string().min(1).max(20),
  date: isoDate,
  currency: z.string().regex(/^[A-Z]{3}$/).default('EUR'),
  /** FPR12 = private (B2B/B2C), FPA12 = public administration (B2G). */
  format: z.enum(FORMATOTRASMISSIONE),
  /** 7 chars private, 6 chars PA/IPA, or "0000000" with recipientPec. */
  recipientCode: z.string().regex(/^[A-Z0-9]{6,7}$/),
  recipientPec: z.string().email().optional(),
  seller: PartySchema,
  buyer: PartySchema,
  lines: z.array(LineItemSchema).min(1),
  summaries: z.array(TaxSummarySchema).min(1),
  payment: PaymentSchema.optional(),
  /** B2G: mandatory in most cases. */
  cig: z.string().max(15).optional(),
  cup: z.string().max(15).optional(),
  purchaseOrderId: z.string().max(20).optional(),

  /**
   * Imposta di bollo virtuale (DatiBollo). Transmitted as sent: PASSO never
   * decides whether stamp duty is due or how much, like it never computes totals.
   * `virtual` is the literal true — BolloVirtualeType allows only "SI".
   */
  stampDuty: z.object({
    virtual: z.literal(true),
    amount: nonNegDecimal,
  }).strict().optional(),

  /**
   * Contract and convention references (XML-015).
   *
   * A PA that issued an invoice against a contract or a convention REQUIRES the
   * matching reference; without it the invoice is rejected with an NS, and NS
   * is terminal. They are structurally identical to DatiOrdineAcquisto.
   */
  contractId: z.string().max(20).optional(),
  conventionId: z.string().max(20).optional(),
  receptionId: z.string().max(20).optional(),

  /**
   * Attachments (XML-019).
   *
   * FatturaPA carries attachments INSIDE the XML as base64, so an attachment
   * counts against the same 30 MB channel limit as the invoice — a 20 MB PDF
   * makes the whole submission undeliverable. The cap here is deliberately
   * lower than the channel limit to leave room for the invoice itself.
   */
  attachments: z.array(z.object({
    name: z.string().min(1).max(60),
    /** e.g. "PDF", "TXT" — the format of the attached file. */
    format: z.string().max(10).optional(),
    description: z.string().max(100).optional(),
    /** Base64. Validated for shape, not decoded here. */
    content: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64'),
  })).max(10).optional(),
}).strict()
  .refine((i) => (i.recipientCode === '0000000' ? !!i.recipientPec : true),
    { message: 'recipientPec is required when recipientCode is 0000000' })
  .refine((i) => (i.format === 'FPA12' ? i.recipientCode.length === 6 : true),
    { message: 'PA recipients (FPA12) use a 6-character IPA code' })
  .refine((i) => !!i.seller.vatId,
    { message: 'seller.vatId is mandatory' })
  .refine((i) => !!i.seller.taxRegime,
    { message: 'seller.taxRegime (RegimeFiscale) is mandatory' })
  .refine((i) => !!(i.buyer.vatId || i.buyer.taxCode),
    { message: 'buyer requires vatId or taxCode' })
  .refine(
    (i) => {
      // Base64 inflates by ~4/3; the decoded total must leave room for the
      // invoice inside the 30 MB channel limit (SDI-031).
      const bytes = (i.attachments ?? []).reduce((n, a) => n + (a.content.length * 3) / 4, 0);
      return bytes <= 20 * 1024 * 1024;
    },
    { message: 'attachments exceed 20MB decoded — the whole submission must fit the 30MB channel limit' },
  );

export type Invoice = z.infer<typeof InvoiceSchema>;
export type Party = z.infer<typeof PartySchema>;
export type LineItem = z.infer<typeof LineItemSchema>;
export type TaxSummary = z.infer<typeof TaxSummarySchema>;
