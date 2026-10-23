import { describe, it, expect } from 'vitest';
import {
  checkSize, assertSizeWithinLimit, assertSigningSatisfied, assertChannelCanCarry,
  SDI_MAX_BYTES,
} from '../../src/infra/channels/guards.ts';
import { MockChannel } from '../../src/infra/channels/mock.ts';
import { OpenApiChannel } from '../../src/infra/channels/openapi.ts';
import { PecChannel } from '../../src/infra/channels/pec.ts';
import { ChannelError } from '../../src/infra/channels/types.ts';

/**
 * Pre-submission channel guards (SDI-031 / SDI-032).
 *
 * These check what the CHANNEL can carry, which the XSD cannot: a document can
 * be perfectly schema-valid and still undeliverable. Both failures would
 * otherwise cost an NS — terminal, requiring a reissued invoice — so catching
 * them here converts a fiscal event into a 400.
 */
const b2b = (bytes = 100) =>
  `<?xml version="1.0"?><p:FatturaElettronica><FormatoTrasmissione>FPR12</FormatoTrasmissione>${'x'.repeat(bytes)}</p:FatturaElettronica>`;
const b2g = (bytes = 100) =>
  `<?xml version="1.0"?><p:FatturaElettronica><FormatoTrasmissione>FPA12</FormatoTrasmissione>${'x'.repeat(bytes)}</p:FatturaElettronica>`;

const pec = new PecChannel();
const openapi = new OpenApiChannel();

describe('30MB size gate', () => {
  it('accepts an ordinary invoice', () => {
    expect(checkSize(b2b(), 'mock').withinLimit).toBe(true);
  });

  it('REFUSES a document over the hard limit', () => {
    expect(() => assertSizeWithinLimit('x'.repeat(SDI_MAX_BYTES + 1), 'mock'))
      .toThrow(ChannelError);
  });

  /**
   * PEC base64-encodes the invoice, inflating it ~4/3 plus MIME overhead. A
   * 25MB XML is comfortably over 30MB on the wire, so measuring the raw bytes
   * would pass a document SdI refuses.
   */
  it('accounts for PEC encoding overhead, not just the raw bytes', () => {
    const raw = 24 * 1024 * 1024;
    expect(checkSize('x'.repeat(raw), 'mock').withinLimit).toBe(true);
    expect(checkSize('x'.repeat(raw), 'pec').withinLimit).toBe(false);
  });

  it('is NOT retryable — the document is the same size next time', () => {
    try {
      assertSizeWithinLimit('x'.repeat(SDI_MAX_BYTES + 1), 'mock');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ChannelError).retryable).toBe(false);
      expect((e as ChannelError).code).toBe('ERR_MESSAGE_TOO_LARGE');
    }
  });

  it('names attachments, since they are the usual cause', () => {
    expect(() => assertSizeWithinLimit('x'.repeat(SDI_MAX_BYTES + 1), 'mock'))
      .toThrow(/attachments/);
  });
});

describe('B2G signing gate', () => {
  it('lets a B2B invoice through unsigned — no signature is required', () => {
    expect(() => assertSigningSatisfied({ xml: b2b() }, pec, {})).not.toThrow();
    expect(() => assertSigningSatisfied({ xml: b2b() }, openapi, {})).not.toThrow();
  });

  /**
   * PEC has no vendor between PASSO and SdI, and PASSO holds no signing key.
   * An unsigned FPA12 over PEC is GUARANTEED to come back as an NS.
   */
  it('REFUSES an unsigned B2G invoice on a channel that cannot sign', () => {
    expect(() => assertSigningSatisfied({ xml: b2g() }, pec, {}))
      .toThrow(/must be signed/);
  });

  /**
   * The regression: the gate used to trust the static capability, which is
   * `true` for OpenAPI.it whatever the tenant configured — so with signing off
   * an unsigned B2G invoice went to SdI and earned a terminal NS.
   */
  it('REFUSES an unsigned B2G invoice on a signing-capable vendor with signing OFF', () => {
    expect(() => assertSigningSatisfied({ xml: b2g() }, openapi, { token: 't' }))
      .toThrow(/"requestSigning": true/);
    expect(() => assertSigningSatisfied({ xml: b2g() }, openapi,
      { token: 't', requestSigning: false })).toThrow(ChannelError);
  });

  it('accepts an unsigned B2G invoice where the vendor WILL sign', () => {
    expect(() => assertSigningSatisfied({ xml: b2g() }, openapi,
      { token: 't', requestSigning: true })).not.toThrow();
  });

  it('accepts a pre-signed B2G invoice on any channel', () => {
    expect(() => assertSigningSatisfied({ xml: b2g(), signed: true }, pec, {})).not.toThrow();
  });

  it('tells a PEC caller to use a signing channel', () => {
    expect(() => assertSigningSatisfied({ xml: b2g() }, pec, {}))
      .toThrow(/server-side signing \(openapi\)/);
  });

  it('is not retryable — resending changes nothing', () => {
    try {
      assertSigningSatisfied({ xml: b2g() }, pec, {});
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ChannelError).retryable).toBe(false);
      expect((e as ChannelError).code).toBe('ERR_VALIDATION_SIGNATURE_REQUIRED');
    }
  });
});

describe('combined guard', () => {
  it('passes a valid invoice on a capable channel', () => {
    expect(() => assertChannelCanCarry({ xml: b2b() }, new MockChannel(), {})).not.toThrow();
  });

  it('reports the health of a channel with no external dependency', async () => {
    const h = await new MockChannel().health!();
    expect(h.ok).toBe(true);
    expect(h.checked).toMatch(/no external dependency/);
  });
});
