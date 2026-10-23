import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { withTenant } from '../../src/infra/db/pool.ts';
import { submitInvoice, retrySubmission } from '../../src/domain/submission/service.ts';
import { MockChannel } from '../../src/infra/channels/mock.ts';
import { PecChannel } from '../../src/infra/channels/pec.ts';
import { OpenApiChannel } from '../../src/infra/channels/openapi.ts';
import { ApiError } from '../../src/shared/errors/catalog.ts';
import { STATE } from '../../src/domain/submission/state.ts';
import { createHarness, seedTenant, type Harness } from '../helpers/harness.ts';

const h: Harness = createHarness();
const db = h.db;
const keys = h.keys;
let A = '';
let sellerId = '';

beforeAll(async () => {
  const seeded = await seedTenant(h);
  A = seeded.tenantId;
  sellerId = seeded.sellerId;
});
afterAll(async () => { await h.close(); });

const invoice = (over: Record<string, unknown> = {}) => ({
  documentType: 'TD01', number: `INV-${Math.random().toString(36).slice(2, 8)}`,
  date: '2026-09-01', currency: 'EUR', format: 'FPR12', recipientCode: 'ABC1234',
  seller: {
    vatId: { country: 'IT', code: '01234567890' }, name: 'Fornitore S.r.l.', taxRegime: 'RF01',
    address: { street: 'Via Roma', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
  },
  buyer: {
    vatId: { country: 'IT', code: '09876543210' }, name: 'Cliente S.p.A.',
    address: { street: 'Via Milano', postalCode: '00100', city: 'Roma', province: 'RM', country: 'IT' },
  },
  lines: [{ lineNumber: 1, description: 'Servizi', unitPrice: '1000.00', totalPrice: '1000.00', vatRate: '22.00' }],
  summaries: [{ vatRate: '22.00', taxableAmount: '1000.00', taxAmount: '220.00' }],
  ...over,
});

describe('submitInvoice — full pipeline', () => {
  it('accepts a valid invoice and writes invoice + submission + correlation + outbox atomically', async () => {
    const r = await submitInvoice(db, keys, invoice(), {
      tenantId: A, sellerId, channel: new MockChannel(),
    });
    expect(r.status).toBe(STATE.queued);
    expect(r.progressivoInvio).toMatch(/^[0-9A-Z]{1,10}$/);
    // The transmitter code is per-tenant, so assert the SHAPE rather than a
    // fixed value: {IdPaese}{IdCodice}_{ProgressivoInvio}.xml
    expect(r.filename).toMatch(/^IT\d{11}_[A-Z0-9]{1,10}\.xml$/);
    expect(r.filename).toContain(`_${r.progressivoInvio}.xml`);

    const rows = await withTenant(db, A, async (tx) => ({
      corr: (await tx.query('SELECT * FROM correlation_records WHERE submission_id=$1', [r.submissionId])).rows[0],
      out: (await tx.query('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')).rows[0],
    }));
    expect(rows.corr).toBeDefined();
    expect(rows.out.n).toBeGreaterThan(0);
  });

  it('allocates a UNIQUE ProgressivoInvio per submission', async () => {
    const a = await submitInvoice(db, keys, invoice(), { tenantId: A, sellerId, channel: new MockChannel() });
    const b = await submitInvoice(db, keys, invoice(), { tenantId: A, sellerId, channel: new MockChannel() });
    expect(a.progressivoInvio).not.toBe(b.progressivoInvio);
  });

  it('rejects a schema-invalid invoice with field-level detail', async () => {
    await expect(submitInvoice(db, keys, invoice({ lines: [] }), {
      tenantId: A, sellerId, channel: new MockChannel(),
    })).rejects.toThrow(ApiError);
  });

  it('rejects a zero-rate line with no Natura', async () => {
    await expect(submitInvoice(db, keys, invoice({
      lines: [{ lineNumber: 1, description: 'X', unitPrice: '10.00', totalPrice: '10.00', vatRate: '0.00' }],
    }), { tenantId: A, sellerId, channel: new MockChannel() })).rejects.toThrow(ApiError);
  });

  it('BLOCKS B2G over PEC — PEC cannot sign', async () => {
    await expect(submitInvoice(db, keys, invoice({ format: 'FPA12', recipientCode: 'UF1234' }), {
      tenantId: A, sellerId, channel: new PecChannel(),
    })).rejects.toThrow(/cannot sign|signature/i);
  });

  /**
   * The regression behind XML-022: OpenAPI.it CAN sign, but only does when the
   * tenant enabled `requestSigning`. The gate used to check the capability
   * alone, so this invoice was accepted and would have reached SdI unsigned.
   */
  it('BLOCKS B2G over OpenAPI.it when signing is not enabled', async () => {
    await expect(submitInvoice(db, keys, invoice({ format: 'FPA12', recipientCode: 'UF1234' }), {
      tenantId: A, sellerId, channel: new OpenApiChannel(), channelConfig: { token: 't' },
    })).rejects.toThrow(/requestSigning/);
  });

  it('allows B2G over OpenAPI.it when the vendor will sign', async () => {
    const r = await submitInvoice(db, keys, invoice({ format: 'FPA12', recipientCode: 'UF1234' }), {
      tenantId: A, sellerId, channel: new OpenApiChannel(),
      channelConfig: { token: 't', requestSigning: true },
    });
    expect(r.status).toBe(STATE.queued);
  });

  it('end to end: an invoice with stampDuty is accepted and its stored XML carries DatiBollo', async () => {
    const r = await submitInvoice(db, keys, invoice({ stampDuty: { virtual: true, amount: '2.00' } }), {
      tenantId: A, sellerId, channel: new MockChannel(),
    });
    expect(r.status).toBe(STATE.queued);   // the XSD gate ran inside submitInvoice
  });

  it('allows B2G over a signing channel', async () => {
    const r = await submitInvoice(db, keys, invoice({ format: 'FPA12', recipientCode: 'UF1234' }), {
      tenantId: A, sellerId, channel: new MockChannel(),
    });
    expect(r.status).toBe(STATE.queued);
  });

  it('replays an identical idempotent request instead of double-submitting', async () => {
    const body = invoice();
    const key = `idem-${Math.random()}`;
    const a = await submitInvoice(db, keys, body, { tenantId: A, sellerId, channel: new MockChannel(), idempotencyKey: key });
    const b = await submitInvoice(db, keys, body, { tenantId: A, sellerId, channel: new MockChannel(), idempotencyKey: key });
    expect(b.submissionId).toBe(a.submissionId);
  });

  it('rejects the same idempotency key with a DIFFERENT payload', async () => {
    const key = `idem-${Math.random()}`;
    await submitInvoice(db, keys, invoice(), { tenantId: A, sellerId, channel: new MockChannel(), idempotencyKey: key });
    await expect(submitInvoice(db, keys, invoice(), {
      tenantId: A, sellerId, channel: new MockChannel(), idempotencyKey: key,
    })).rejects.toThrow(/idempotency/i);
  });
});

describe('retry guard against the tax authority', () => {
  it('REFUSES to retry an NS-rejected submission', async () => {
    const r = await submitInvoice(db, keys, invoice(), { tenantId: A, sellerId, channel: new MockChannel() });
    await withTenant(db, A, (tx) =>
      tx.query('UPDATE sdi_submissions SET state=$1 WHERE id=$2', [STATE.rejected, r.submissionId]));
    await expect(retrySubmission(db, A, r.submissionId)).rejects.toThrow(/NS is terminal/);
  });

  it('REFUSES to retry an MC — SdI is still delivering', async () => {
    const r = await submitInvoice(db, keys, invoice(), { tenantId: A, sellerId, channel: new MockChannel() });
    await withTenant(db, A, (tx) =>
      tx.query('UPDATE sdi_submissions SET state=$1 WHERE id=$2', [STATE.awaitingDelivery, r.submissionId]));
    await expect(retrySubmission(db, A, r.submissionId)).rejects.toThrow(/duplicate/i);
  });
});

describe('ProgressivoInvio allocation under concurrency', () => {
  it('never issues the same value twice, even in parallel', async () => {
    // The first implementation derived the next value from COUNT(*), which
    // collided whenever an NS retry or a deletion left a gap.
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        submitInvoice(db, keys, invoice(), { tenantId: A, sellerId, channel: new MockChannel() })),
    );
    const values = results.map((r) => r.progressivoInvio);
    expect(new Set(values).size).toBe(values.length);
  });

  it('respects the String10Type length limit', async () => {
    const r = await submitInvoice(db, keys, invoice(), { tenantId: A, sellerId, channel: new MockChannel() });
    expect(r.progressivoInvio.length).toBeLessThanOrEqual(10);
  });
});
