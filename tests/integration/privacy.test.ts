import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createHarness, seedTenant, validInvoice, type Harness } from '../helpers/harness.ts';
import { withTenant } from '../../src/infra/db/pool.ts';
import { verifyAllChains } from '../../src/workers/chain-verifier.ts';
import { logger } from '../../src/shared/logger.ts';

/**
 * Data-subject surfaces (SEC-025 / SEC-028 / SEC-029).
 *
 * PASSO is a relay, not an archive, and both of these look different because of
 * it: erasure is mostly answering accurately about a tiny surface, and export
 * is what makes purge safe — the CRM must be able to take everything before the
 * payload is destroyed.
 */
let h: Harness;
let t = { tenantId: '', sellerId: '', apiKey: '' };
let other = { tenantId: '', sellerId: '', apiKey: '' };

beforeAll(async () => {
  h = createHarness();
  t = await seedTenant(h);
  other = await seedTenant(h);
});
afterAll(async () => { await h.close(); });

const auth = () => ({ authorization: `Bearer ${t.apiKey}` });
const submit = async () => {
  const r = await request(h.app).post('/api/v1/invoices').set(auth())
    .send({ sellerId: t.sellerId, invoice: validInvoice() });
  return r.body.submissionId as string;
};

describe('pre-purge export', () => {
  it('returns the XML with a hash the caller can verify INDEPENDENTLY', async () => {
    const r = await request(h.app).get(`/api/v1/invoices/${await submit()}/export`).set(auth());
    expect(r.status).toBe(200);
    // Over the plaintext bytes, so the recipient can check it against the file
    // they hold without knowing anything about our storage.
    const computed = createHash('sha256').update(r.body.xml).digest('hex');
    expect(r.body.hashes.xmlSha256).toBe(computed);
  });

  it('includes the rendering, receipts and transmission metadata', async () => {
    const r = await request(h.app).get(`/api/v1/invoices/${await submit()}/export`).set(auth());
    expect(r.body.rendered).toBeTruthy();
    expect(Array.isArray(r.body.notifications)).toBe(true);
    expect(r.body.transmission.channel).toBeTruthy();
    expect(r.body.invoice.progressivoInvio).toBeTruthy();
  });

  it('is TENANT-SCOPED — another tenant gets 404, not the package', async () => {
    const id = await submit();
    const r = await request(h.app).get(`/api/v1/invoices/${id}/export`)
      .set({ authorization: `Bearer ${other.apiKey}` });
    expect(r.status).toBe(404);
  });

  /**
   * 410, not 404: the difference between "you got the id wrong" and "you were
   * too late". A CRM that sees 410 knows its integration has a real gap.
   */
  it('returns 410 GONE after purge, explaining there is no archive', async () => {
    const id = await submit();
    await withTenant(h.db, t.tenantId, (tx) => tx.query(
      `UPDATE sdi_submissions SET xml_encrypted = NULL, purged_at = now(),
              terminal_at = now(), state = 'delivered' WHERE id = $1`, [id]));
    const r = await request(h.app).get(`/api/v1/invoices/${id}/export`).set(auth());
    expect(r.status).toBe(410);
    expect(r.body.error.message).toMatch(/no archive|purged/i);
  });

  it('AUDITS every export — taking a full copy is a recordable act', async () => {
    const id = await submit();
    await request(h.app).get(`/api/v1/invoices/${id}/export`).set(auth());
    const rows = await withTenant(h.db, t.tenantId, (tx) => tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE action = 'submission.export' AND resource_id = $1`, [id]));
    expect(rows.rows[0]!.n).toBeGreaterThan(0);
  });
});

describe('erasure request', () => {
  const ask = (body: object) =>
    request(h.app).post('/api/v1/privacy/erasure').set(auth()).send(body);

  it('states plainly that PASSO holds NO archive', async () => {
    const r = await ask({ vatId: '09876543210' });
    expect(r.status).toBe(200);
    expect(r.body.holds.archive).toBe(false);
    expect(r.body.controller).toMatch(/CRM is the controller/i);
  });

  it('REFUSES an in-flight document for the transmission reason, not retention', async () => {
    await submit();
    const r = await ask({ vatId: '09876543210' });
    expect(r.body.erasable).toBe(false);
    expect(r.body.refusal.reason).toBe('transmission_in_flight');
    // The superseded position must never reappear: PASSO has no retention duty.
    expect(JSON.stringify(r.body)).not.toMatch(/Art\.? ?2220|10.year|retention duty/i);
    expect(r.body.refusal.explanation).toMatch(/NOT a retention-duty refusal/);
  });

  it('names the expected purge point rather than a date it cannot know', async () => {
    await submit();
    const r = await ask({ vatId: '09876543210' });
    expect(r.body.refusal.documents[0].expectedPurge).toMatch(/terminal receipt/);
  });

  it('refuses audit erasure on INTEGRITY grounds and says the log expires anyway', async () => {
    const r = await ask({ vatId: '09876543210' });
    expect(r.body.auditLog.erasable).toBe(false);
    expect(r.body.auditLog.reason).toMatch(/hash-chained/);
    expect(r.body.auditLog.reason).toMatch(/retention schedule/);
  });

  it('requires a subject identifier', async () => {
    expect((await ask({})).status).toBe(400);
  });

  it('is itself AUDITED — a privacy request is a recordable event', async () => {
    await ask({ vatId: '09876543210' });
    const rows = await withTenant(h.db, t.tenantId, (tx) => tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'privacy.erasure_request'`));
    expect(rows.rows[0]!.n).toBeGreaterThan(0);
  });
});

/**
 * SEC-025 — the chain makes tampering detectable; this is what detects it.
 * Without a scheduled check, a deleted row is found only when someone thinks to
 * look, which is during the investigation the tampering was meant to defeat.
 */
describe('periodic chain verification', () => {
  it('verifies a freshly created tenant chain as intact', async () => {
    const fresh = await seedTenant(h);
    await request(h.app).post('/api/v1/invoices')
      .set({ authorization: `Bearer ${fresh.apiKey}` })
      .send({ sellerId: fresh.sellerId, invoice: validInvoice() });

    const report = await verifyAllChains(h.db, logger);
    expect(report.checked).toBeGreaterThan(0);
    // Scoped to this tenant: a shared development database accumulates other
    // tenants whose rows earlier tamper-detection tests deliberately deleted.
    expect(report.broken.map((b) => b.tenantId)).not.toContain(fresh.tenantId);
  });

  it('DETECTS a deleted audit row', async () => {
    const seeded = await seedTenant(h);
    // THREE, so there is a genuine middle row: deleting the newest breaks no
    // link (nothing points at it yet), which is exactly the case this test must
    // avoid if it is to prove anything.
    for (let i = 0; i < 3; i++) {
      await request(h.app).post('/api/v1/invoices')
        .set({ authorization: `Bearer ${seeded.apiKey}` })
        .send({ sellerId: seeded.sellerId, invoice: validInvoice() });
    }

    /**
     * Remove a row from the MIDDLE. Deleting the newest row breaks no link —
     * nothing points at it yet — which is precisely the case a per-row hash
     * would also miss, and why the chain covers the previous hash instead.
     */
    const before = await withTenant(h.db, seeded.tenantId, (tx) =>
      tx.query<{ n: string }>('SELECT count(*) AS n FROM audit_log'));
    expect(Number(before.rows[0]!.n)).toBeGreaterThanOrEqual(3);

    // Deleting requires the tenant context too: without it RLS matches zero
    // rows and the "tamper" silently does nothing.
    await withTenant(h.db, seeded.tenantId, (tx) => tx.query(
      `DELETE FROM audit_log WHERE id = (
         SELECT id FROM audit_log ORDER BY id LIMIT 1 OFFSET 1)`));

    const report = await verifyAllChains(h.db, logger);
    expect(report.broken.map((b) => b.tenantId)).toContain(seeded.tenantId);
  });
});
