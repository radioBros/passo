import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { withTenant, withQuarantineRole } from '../../src/infra/db/pool.ts';
import { ingestNotification, eventFor } from '../../src/domain/notification/service.ts';
import { parseNotification } from '../../src/domain/notification/parser.ts';
import { submitInvoice } from '../../src/domain/submission/service.ts';
import { MockChannel } from '../../src/infra/channels/mock.ts';
import { logger } from '../../src/shared/logger.ts';
import { STATE } from '../../src/domain/submission/state.ts';
import { createHarness, seedTenant, type Harness } from '../helpers/harness.ts';

const h: Harness = createHarness();
const db = h.db;
const keys = h.keys;
let A = '';
let sellerId = '';
afterAll(async () => { await h.close(); });
beforeAll(async () => {
  const seeded = await seedTenant(h);
  A = seeded.tenantId;
  sellerId = seeded.sellerId;
});

const fixture = (t: string, sdiId: string) =>
  parseNotification(
    readFileSync(`tests/fixtures/official/IT01234567890_11111_${t}_001.xml`, 'utf8')
      .replace(/<IdentificativoSdI>[^<]*<\/IdentificativoSdI>/, `<IdentificativoSdI>${sdiId}</IdentificativoSdI>`),
  );

const newSubmission = async (sdiId: string) => {
  const r = await submitInvoice(db, keys, {
    documentType: 'TD01', number: `N-${Math.random().toString(36).slice(2, 8)}`,
    date: '2026-09-01', currency: 'EUR', format: 'FPR12', recipientCode: 'ABC1234',
    seller: { vatId: { country: 'IT', code: '01234567890' }, name: 'F S.r.l.', taxRegime: 'RF01',
      address: { street: 'V', postalCode: '20100', city: 'M', province: 'MI', country: 'IT' } },
    buyer: { vatId: { country: 'IT', code: '09876543210' }, name: 'C S.p.A.',
      address: { street: 'V', postalCode: '00100', city: 'R', province: 'RM', country: 'IT' } },
    lines: [{ lineNumber: 1, description: 'S', unitPrice: '10.00', totalPrice: '10.00', vatRate: '22.00' }],
    summaries: [{ vatRate: '22.00', taxableAmount: '10.00', taxAmount: '2.20' }],
  }, { tenantId: A, sellerId, channel: new MockChannel() });
  await withTenant(db, A, (tx) => tx.query(
    'UPDATE correlation_records SET identificativo_sdi=$2 WHERE submission_id=$1', [r.submissionId, sdiId]));
  await withTenant(db, A, (tx) => tx.query(
    'UPDATE sdi_submissions SET state=$2 WHERE id=$1', [r.submissionId, STATE.transmitted]));
  return r.submissionId;
};

describe('notification ingress', () => {
  it('routes an RC by IdentificativoSdI and marks delivered', async () => {
    const sdiId = `rc-${Date.now()}`;
    await newSubmission(sdiId);
    const r = await ingestNotification(db, keys, logger, fixture('RC', sdiId), 'mock');
    expect(r.status).toBe('applied');
    expect(r.newState).toBe(STATE.delivered);
  });

  it('an NS marks rejected — terminal, invoice legally NOT issued', async () => {
    const sdiId = `ns-${Date.now()}`;
    const id = await newSubmission(sdiId);
    const r = await ingestNotification(db, keys, logger, fixture('NS', sdiId), 'mock');
    expect(r.newState).toBe(STATE.rejected);
    const row = await withTenant(db, A, (tx) => tx.query<{ parsed: { errors: unknown[] } }>(
      'SELECT parsed FROM notifications WHERE submission_id=$1', [id]));
    // NS carries a LIST of errors, never a single code.
    expect(Array.isArray(row.rows[0]!.parsed.errors)).toBe(true);
    expect(row.rows[0]!.parsed.errors.length).toBeGreaterThan(0);
  });

  it('an MC is NOT terminal — SdI is still delivering', async () => {
    const sdiId = `mc-${Date.now()}`;
    await newSubmission(sdiId);
    const r = await ingestNotification(db, keys, logger, fixture('MC', sdiId), 'mock');
    expect(r.newState).toBe(STATE.awaitingDelivery);
  });

  it('is idempotent — a redelivered notification does not re-apply', async () => {
    const sdiId = `dup-${Date.now()}`;
    await newSubmission(sdiId);
    expect((await ingestNotification(db, keys, logger, fixture('RC', sdiId), 'mock')).status).toBe('applied');
    expect((await ingestNotification(db, keys, logger, fixture('RC', sdiId), 'mock')).status).toBe('duplicate');
  });

  it('QUARANTINES an unmatched notification — never discards it', async () => {
    // Reading quarantined payloads requires the dedicated role: the
    // tenant-scoped role deliberately cannot SELECT them (SEC-037).
    const before = await withQuarantineRole(db, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM quarantined_notifications'));
    const r = await ingestNotification(db, keys, logger, fixture('RC', `orphan-${Date.now()}`), 'pec');
    expect(r.status).toBe('quarantined');
    const after = await withQuarantineRole(db, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM quarantined_notifications'));
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 1);
  });

  it('quarantines receiver-flow types (MT/EC/SE) rather than failing', async () => {
    for (const t of ['MT', 'EC', 'SE']) {
      const r = await ingestNotification(db, keys, logger, fixture(t, `x-${Date.now()}`), 'pec');
      expect(r.status, t).toBe('quarantined');
    }
  });

  it('enqueues a webhook event on state change', async () => {
    const sdiId = `wh-${Date.now()}`;
    await newSubmission(sdiId);
    const before = await withTenant(db, A, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox'));
    await ingestNotification(db, keys, logger, fixture('RC', sdiId), 'mock');
    const after = await withTenant(db, A, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM outbox'));
    expect(after.rows[0]!.n).toBeGreaterThan(before.rows[0]!.n);
  });
});

describe('webhook event mapping', () => {
  it('maps each notification to the right event', () => {
    expect(eventFor('RC')).toBe('invoice.delivered');
    expect(eventFor('NS')).toBe('invoice.rejected');
    expect(eventFor('MC')).toBe('invoice.exception');
    expect(eventFor('DT')).toBe('invoice.delivered');
    expect(eventFor('AT')).toBe('invoice.transmitted_undelivered');
    expect(eventFor('NE', 'EC01')).toBe('invoice.accepted_by_pa');
    expect(eventFor('NE', 'EC02')).toBe('invoice.rejected_by_pa');
  });
});
