import { ChannelError, type SdiChannelAdapter } from './types.ts';

/**
 * Pre-submission channel guards (SDI-031 / SDI-032).
 *
 * These check what the CHANNEL can carry, which the XSD cannot: a document can
 * be perfectly schema-valid and still be undeliverable because it is too large
 * or unsigned for the route it is taking.
 *
 * Both failures are worth catching here rather than at the vendor, because both
 * would otherwise cost an NS — and NS is terminal, so the invoice has to be
 * reissued rather than resent.
 */

/**
 * SdI's hard limit: *"Il messaggio, comprensivo dell'allegato, non deve
 * superare la dimensione di 30 megabytes"*. Not advisory.
 */
export const SDI_MAX_BYTES = 30 * 1024 * 1024;

/**
 * PEC adds MIME and base64 overhead on top of the XML.
 *
 * Base64 inflates by 4/3, plus headers and boundaries. A document at 25 MB of
 * XML is comfortably over 30 MB once encoded — which is why the check has to
 * account for the encoding rather than measure the raw bytes.
 */
const PEC_ENCODING_FACTOR = 1.4;

export interface SizeCheck {
  rawBytes: number;
  estimatedWireBytes: number;
  limit: number;
  withinLimit: boolean;
}

/** Stage 1: estimate at validation time, before anything is queued. */
export function checkSize(xml: string, channel: string): SizeCheck {
  const rawBytes = Buffer.byteLength(xml, 'utf8');
  const factor = channel === 'pec' ? PEC_ENCODING_FACTOR : 1;
  const estimatedWireBytes = Math.ceil(rawBytes * factor);
  return {
    rawBytes, estimatedWireBytes, limit: SDI_MAX_BYTES,
    withinLimit: estimatedWireBytes <= SDI_MAX_BYTES,
  };
}

export function assertSizeWithinLimit(xml: string, channel: string): void {
  const c = checkSize(xml, channel);
  if (!c.withinLimit) {
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    throw new ChannelError(
      `message is ${mb(c.estimatedWireBytes)}MB encoded (${mb(c.rawBytes)}MB of XML) and ` +
      `SdI's hard limit is ${mb(c.limit)}MB. Reduce or remove attachments — they travel ` +
      'inside the invoice and count against the same limit.',
      // Not retryable: the document will be exactly as large next time.
      false, 'ERR_MESSAGE_TOO_LARGE',
    );
  }
}

/**
 * A B2G invoice must carry a digital signature (SDI-032 / XML-022).
 *
 * PASSO holds no signing key, so the signature has to come from the channel:
 * Invoicetronic and OpenAPI.it sign server-side, but ONLY when the tenant
 * enabled `requestSigning`. PEC has no vendor in the path and cannot sign.
 *
 * An unsigned FPA12 document is *guaranteed* an NS, which is terminal and
 * forces a reissue. Refusing here turns that fiscal event into a 400 the CRM
 * can act on immediately.
 *
 * The check asks `willSign(config)`, never just the static capability: an
 * earlier version trusted `serverSideSigning`, which is true for both vendors
 * regardless of configuration, and so let unsigned B2G invoices through.
 */
export function signingSatisfied(
  isB2G: boolean, signed: boolean, adapter: SdiChannelAdapter, config: Record<string, unknown>,
): boolean {
  return !isB2G || signed || adapter.willSign(config);
}

export function signingRequiredMessage(adapter: SdiChannelAdapter): string {
  return adapter.capabilities.serverSideSigning
    ? `a B2G invoice (FormatoTrasmissione FPA12) must be signed, and signing is not ` +
      `enabled on the "${adapter.name}" channel. Set "requestSigning": true in the ` +
      'channel configuration so the vendor signs it.'
    : `a B2G invoice (FormatoTrasmissione FPA12) must be signed, and the ` +
      `"${adapter.name}" channel cannot sign — PASSO holds no signing key and there is ` +
      'no vendor in this path. Use a channel with server-side signing (openapi) for B2G.';
}

export function assertSigningSatisfied(
  input: { xml: string; signed?: boolean }, adapter: SdiChannelAdapter,
  config: Record<string, unknown>,
): void {
  const isB2G = /<FormatoTrasmissione>FPA12</.test(input.xml);
  if (signingSatisfied(isB2G, input.signed ?? false, adapter, config)) return;
  throw new ChannelError(signingRequiredMessage(adapter), false,
    'ERR_VALIDATION_SIGNATURE_REQUIRED');
}

/** Every pre-submission channel guard, in one call. */
export function assertChannelCanCarry(
  input: { xml: string; signed?: boolean }, adapter: SdiChannelAdapter,
  config: Record<string, unknown>,
): void {
  assertSizeWithinLimit(input.xml, adapter.name);
  assertSigningSatisfied(input, adapter, config);
}
