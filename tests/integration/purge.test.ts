import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { withTenant, withQuarantineRole, withTx } from '../../src/infra/db/pool.ts';
import { runPurge } from '../../src/workers/purge.ts';
import { submitInvoice } from '../../src/domain/submission/service.ts';
import { MockChannel } from '../../src/infra/channels/mock.ts';
import { logger } from '../../src/shared/logger.ts';
import { STATE } from '../../src/domain/submission/state.ts';
import { createHarness, seedTenant, type Harness } from '../helpers/harness.ts';

const h: Harness = createHarness();
const db = h.db;
const keys = h.keys;
const cfg = h.cfg;
let A = '';
let sellerId = '';
afterAll(async () => { await h.close(); });
beforeAll(async () => {
  const seeded = await seedTenant(h);
  A = seeded.tenantId;
  sellerId = seeded.sellerId;
});

const submit = async () => submitInvoice(db, keys, {
  documentType: 'TD01', number: `P-${Math.random().toString(36).slice(2, 8)}`,
  date: '2026-09-01', currency: 'EUR', format: 'FPR12', recipientCode: 'ABC1234',
  seller: { vatId: { country: 'IT', code: '01234567890' }, name: 'F', taxRegime: 'RF01',
    address: { street: 'V', postalCode: '20100', city: 'M', province: 'MI', country: 'IT' } },
  buyer: { vatId: { country: 'IT', code: '09876543210' }, name: 'C',
    address: { street: 'V', postalCode: '00100', city: 'R', province: 'RM', country: 'IT' } },
  lines: [{ lineNumber: 1, description: 'S', unitPrice: '10.00', totalPrice: '10.00', vatRate: '22.00' }],
  summaries: [{ vatRate: '22.00', taxableAmount: '10.00', taxAmount: '2.20' }],
}, { tenantId: A, sellerId, channel: new MockChannel() });

describe('purge — the stateless-relay guarantee', () => {
  it('does NOT purge a submission that has not reached a terminal state', async () => {
    const r = await submit();
    await runPurge(db, cfg, logger);
    const row = await withTenant(db, A, (tx) => tx.query<{ xml_encrypted: Buffer | null }>(
      'SELECT xml_encrypted FROM sdi_submissions WHERE id=$1', [r.submissionId]));
    expect(row.rows[0]!.xml_encrypted).not.toBeNull();
  });

  it('purges the XML once a terminal receipt has arrived', async () => {
    const r = await submit();
    await withTenant(db, A, (tx) => tx.query(
      'UPDATE sdi_submissions SET state=$2, terminal_at=now() WHERE id=$1',
      [r.submissionId, STATE.delivered]));
    await runPurge(db, cfg, logger);
    const row = await withTenant(db, A, (tx) => tx.query<{ xml_encrypted: Buffer | null; purged_at: Date | null }>(
      'SELECT xml_encrypted, purged_at FROM sdi_submissions WHERE id=$1', [r.submissionId]));
    expect(row.rows[0]!.xml_encrypted).toBeNull();
    expect(row.rows[0]!.purged_at).not.toBeNull();
  });

  it('keeps the CORRELATION RECORD after purge so a late receipt still routes', async () => {
    const r = await submit();
    await withTenant(db, A, (tx) => tx.query(
      'UPDATE sdi_submissions SET state=$2, terminal_at=now() WHERE id=$1',
      [r.submissionId, STATE.delivered]));
    await runPurge(db, cfg, logger);
    const c = await withTenant(db, A, (tx) => tx.query(
      'SELECT 1 FROM correlation_records WHERE submission_id=$1', [r.submissionId]));
    expect(c.rowCount).toBe(1);
  });

  it('NEVER purges an unacknowledged receipt, regardless of age', async () => {
    const r = await submit();
    await withTenant(db, A, (tx) => tx.query(
      `INSERT INTO notifications (tenant_id, submission_id, type, channel, received_at)
       VALUES ($1,$2,'RC','mock', now() - interval '10 years')`, [A, r.submissionId]));
    await runPurge(db, cfg, logger);
    const n = await withTenant(db, A, (tx) => tx.query(
      'SELECT 1 FROM notifications WHERE submission_id=$1', [r.submissionId]));
    expect(n.rowCount).toBe(1);   // still there after ten simulated years
  });

  it('the DATABASE refuses purge-eligibility without acknowledgement', async () => {
    const r = await submit();
    await expect(withTenant(db, A, (tx) => tx.query(
      `INSERT INTO notifications (tenant_id, submission_id, type, channel, purge_eligible_at)
       VALUES ($1,$2,'RC','mock', now())`, [A, r.submissionId],
    ))).rejects.toThrow(/notifications_purge_requires_ack|violates check constraint/);
  });

  it('purges an acknowledged receipt past its grace window', async () => {
    const r = await submit();
    await withTenant(db, A, (tx) => tx.query(
      `INSERT INTO notifications (tenant_id, submission_id, type, channel,
        acknowledged_at, ack_method, purge_eligible_at)
       VALUES ($1,$2,'RC','mock', now(), 'explicit_ack', now() - interval '1 day')`,
      [A, r.submissionId]));
    const stats = await runPurge(db, cfg, logger);
    expect(stats.receipts).toBeGreaterThan(0);
  });

  it('writes an audit entry for every purge', async () => {
    const r = await submit();
    await withTenant(db, A, (tx) => tx.query(
      'UPDATE sdi_submissions SET state=$2, terminal_at=now() WHERE id=$1',
      [r.submissionId, STATE.delivered]));
    await runPurge(db, cfg, logger);
    const a = await withTenant(db, A, (tx) => tx.query(
      `SELECT 1 FROM audit_log WHERE action='payload.purge' AND resource_id=$1`, [r.submissionId]));
    expect(a.rowCount).toBe(1);
  });
});

/**
 * Operational-table retention.
 *
 * These tables hold no fiscal record, so nothing in the retention story forced
 * them to be bounded and they grew forever. Bounding them introduces a new
 * risk: these are also the tables holding work IN PROGRESS. Every test below
 * asserts the narrow predicate — only FINISHED rows are eligible — because
 * deleting a pending outbox row silently loses an accepted invoice.
 */
describe('operational table retention', () => {
  it('purges an outbox row that was PUBLISHED long ago', async () => {
    const v = await seedTenant(h);
    await withTenant(h.db, v.tenantId, (tx) => tx.query(
      `INSERT INTO outbox (tenant_id, exchange, routing_key, payload, published_at)
       VALUES ($1,'x','k','{}'::jsonb, now() - interval '400 days')`, [v.tenantId]));
    const before = await countOutbox(v.tenantId);
    await runPurge(h.db, h.cfg, logger, v.tenantId);
    expect(await countOutbox(v.tenantId)).toBeLessThan(before);
  });

  it('NEVER purges an UNPUBLISHED outbox row — that is an unsent invoice', async () => {
    const v = await seedTenant(h);
    await withTenant(h.db, v.tenantId, (tx) => tx.query(
      `INSERT INTO outbox (tenant_id, exchange, routing_key, payload, created_at)
       VALUES ($1,'x','pending','{}'::jsonb, now() - interval '999 days')`, [v.tenantId]));
    await runPurge(h.db, h.cfg, logger, v.tenantId);
    const left = await withTenant(h.db, v.tenantId, (tx) => tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox
        WHERE routing_key = 'pending' AND published_at IS NULL`));
    // Age is never a reason to delete work that has not been done.
    expect(left.rows[0]!.n).toBe(1);
  });

  it('NEVER purges an UNRESOLVED quarantined receipt, however old', async () => {
    const id = `ancient-${Math.random().toString(36).slice(2, 8)}`;
    await withTx(h.db, (tx) => tx.query(
      `INSERT INTO quarantined_notifications (reason,type,identificativo_sdi,raw,channel,created_at)
       VALUES ('old','RC',$1,'<x/>','pec', now() - interval '999 days')`, [id]));
    await runPurge(h.db, h.cfg, logger);
    const left = await withQuarantineRole(h.db, (tx) => tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM quarantined_notifications
        WHERE identificativo_sdi = $1`, [id]));
    // Its owning tenant is still unknown — it remains a legal document.
    expect(left.rows[0]!.n).toBe(1);
  });

  it('purges a RESOLVED quarantined receipt past the window', async () => {
    const id = `settled-${Math.random().toString(36).slice(2, 8)}`;
    await withTx(h.db, (tx) => tx.query(
      `INSERT INTO quarantined_notifications
         (reason,type,identificativo_sdi,raw,channel,resolved_at,resolved_by)
       VALUES ('done','RC',$1,'<x/>','pec', now() - interval '400 days','op')`, [id]));
    await runPurge(h.db, h.cfg, logger);
    const left = await withQuarantineRole(h.db, (tx) => tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM quarantined_notifications
        WHERE identificativo_sdi = $1`, [id]));
    expect(left.rows[0]!.n).toBe(0);
  });

  it('keeps a FAILED webhook delivery — a success is noise, a failure is evidence', async () => {
    const v = await seedTenant(h);
    const wh = await withTenant(h.db, v.tenantId, (tx) => tx.query<{ id: string }>(
      `INSERT INTO webhooks (tenant_id,url,events,secret_encrypted,secret_key_version,secret_iv,secret_tag)
       VALUES ($1,'https://1.1.1.1/h','{invoice.delivered}','\\x00','v1','\\x00','\\x00')
       RETURNING id`, [v.tenantId]));
    await withTenant(h.db, v.tenantId, (tx) => tx.query(
      `INSERT INTO webhook_deliveries
         (tenant_id, webhook_id, event_id, event_type, attempt, error, created_at)
       VALUES ($1,$2,'evt-fail','invoice.delivered',1,'boom', now() - interval '400 days')`,
      [v.tenantId, wh.rows[0]!.id]));
    await runPurge(h.db, h.cfg, logger, v.tenantId);
    const left = await withTenant(h.db, v.tenantId, (tx) => tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM webhook_deliveries WHERE event_id = 'evt-fail'`));
    expect(left.rows[0]!.n).toBe(1);
  });

  it('reports what it removed, so growth is observable', async () => {
    const stats = await runPurge(h.db, h.cfg, logger);
    for (const k of ['outboxRows', 'deliveryRows', 'idempotencyRows', 'quarantineRows']) {
      expect(stats).toHaveProperty(k);
      expect(typeof (stats as unknown as Record<string, number>)[k]).toBe('number');
    }
  });
});

const countOutbox = async (tenantId: string) =>
  (await withTenant(h.db, tenantId, (tx) => tx.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM outbox'))).rows[0]!.n;
