import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { createHarness, seedTenant, validInvoice, ADMIN_KEY, type Harness } from '../helpers/harness.ts';
import { withTenant } from '../../src/infra/db/pool.ts';

/**
 * Inbound vendor webhooks (SDI-026 / NOTIF-007).
 *
 * This endpoint is publicly reachable AND it changes invoice state, which makes
 * it the highest-value forgery target in the system. A forged NS tells a CRM
 * its invoice was rejected when it was not — and because NS is terminal, the
 * CRM issues a replacement for a perfectly valid document.
 */
let h: Harness;
let t = { tenantId: '', sellerId: '', apiKey: '' };
let inboundUrl = '';

const admin = () => ({ authorization: `Bearer ${ADMIN_KEY}` });

beforeAll(async () => {
  h = createHarness();
  t = await seedTenant(h);
  const r = await request(h.app)
    .put(`/api/v1/admin/tenants/${t.tenantId}/channels/invoicetronic`)
    // A sandbox-prefixed key: the environment guard refuses ik_live_ outside
    // production, and a key with neither prefix is not an Invoicetronic key.
    .set(admin()).send({ apiKey: 'ik_test_vendor-key' });
  inboundUrl = new URL(r.body.inboundWebhookUrl).pathname;
});
afterAll(async () => { await h.close(); });

const rc = (sdiId: string) =>
  readFileSync('tests/fixtures/official/IT01234567890_11111_RC_001.xml', 'utf8')
    .replace(/<IdentificativoSdI>[^<]*<\/IdentificativoSdI>/,
             `<IdentificativoSdI>${sdiId}</IdentificativoSdI>`);

const post = (path: string, body: string) =>
  request(h.app).post(path).set('content-type', 'application/xml').send(body);

describe('inbound webhook', () => {
  it('issues a webhook URL when a PUSH channel is configured', () => {
    expect(inboundUrl).toMatch(/^\/api\/v1\/inbound\/pwh_/);
  });

  it('does NOT issue one for a polled channel — an unused credential is a liability', async () => {
    const other = await seedTenant(h);
    const r = await request(h.app)
      .put(`/api/v1/admin/tenants/${other.tenantId}/channels/pec`)
      .set(admin()).send({ smtpHost: 'x', smtpPort: 465, imapHost: 'x', imapPort: 993,
                           user: 'a@pec.it', password: 'p' });
    expect(r.body.inboundWebhookUrl).toBeUndefined();
  });

  it('REJECTS an unknown token', async () => {
    const r = await post('/api/v1/inbound/pwh_totallymadeupvalue123', rc('x-1'));
    expect(r.status).toBe(401);
  });

  it('REJECTS a short token without touching the database', async () => {
    expect((await post('/api/v1/inbound/short', rc('x-2'))).status).toBe(401);
  });

  it('accepts an authenticated notification', async () => {
    const r = await post(inboundUrl, rc(`in-${Date.now()}`));
    expect(r.status).toBe(200);
    expect(r.body.received).toBe(true);
  });

  /**
   * A vendor that receives a non-2xx retries. Returning an error for a
   * notification we successfully quarantined would produce an endless retry
   * loop over something already handled.
   */
  it('returns 200 for an UNMATCHED notification, so the vendor stops retrying', async () => {
    const r = await post(inboundUrl, rc(`orphan-${Date.now()}`));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('quarantined');
  });

  it('is idempotent — a redelivered notification does not re-apply', async () => {
    /**
     * The submission must belong to the tenant whose TOKEN this webhook uses:
     * a receipt routing to a different tenant is now refused as a forgery, so
     * seeding a fresh tenant here would exercise that guard instead.
     */
    const sub = await request(h.app).post('/api/v1/invoices')
      .set({ authorization: `Bearer ${t.apiKey}` })
      .send({ sellerId: t.sellerId, invoice: validInvoice() });
    const sdiId = `dup-${Date.now()}`;
    await withTenant(h.db, t.tenantId, (tx) => tx.query(
      `UPDATE correlation_records SET identificativo_sdi = $2 WHERE submission_id = $1`,
      [sub.body.submissionId, sdiId]));
    await withTenant(h.db, t.tenantId, (tx) => tx.query(
      `UPDATE sdi_submissions SET state = 'transmitted' WHERE id = $1`, [sub.body.submissionId]));

    const first = await post(inboundUrl, rc(sdiId));
    const second = await post(inboundUrl, rc(sdiId));
    expect(first.body.status).toBe('applied');
    expect(second.body.status).toBe('duplicate');
  });

  it('REFUSES an unparseable body without echoing it back', async () => {
    const secret = 'CANARY-abc123-do-not-reflect';
    const r = await post(inboundUrl, `<garbage>${secret}</garbage>`);
    expect(r.status).toBe(400);
    // Reflecting the body turns this endpoint into an oracle.
    expect(JSON.stringify(r.body)).not.toContain(secret);
  });

  it('REFUSES an XXE payload', async () => {
    const xxe = `<?xml version="1.0"?>
      <!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
      <r>&xxe;</r>`;
    const r = await post(inboundUrl, xxe);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toMatch(/root:|\/bin\/(ba)?sh/);
  });

  it('REFUSES an oversized body before parsing it', async () => {
    const r = await post(inboundUrl, '<a>' + 'x'.repeat(3 * 1024 * 1024) + '</a>');
    expect(r.status).toBe(413);
  });

  it('rejects an empty body', async () => {
    expect((await post(inboundUrl, '')).status).toBe(400);
  });

  it('needs NO API key — the vendor holds none', async () => {
    // Authentication is the path token; requiring a tenant key too would make
    // the endpoint unusable by the vendors it exists for.
    const r = await post(inboundUrl, rc(`noauth-${Date.now()}`));
    expect(r.status).toBe(200);
  });
});

/**
 * Cross-tenant forgery through the inbound webhook.
 *
 * `routeNotification` runs under `passo_router`, which bypasses RLS by design —
 * it must, because its whole job is finding a tenant that is not yet known.
 * That makes `IdentificativoSdI` attacker-controlled routing input.
 *
 * Before the fix, a tenant holding ANY inbound token could post a forged
 * NotificaScarto carrying another tenant's IdentificativoSdI and drive their
 * live invoice to `rejected`. NS is terminal, so that CRM would reissue a
 * document that was perfectly valid — and receive an `invoice.rejected`
 * webhook for it.
 */
describe('cross-tenant forgery', () => {
  const ns = (sdiId: string) =>
    readFileSync('tests/fixtures/official/IT01234567890_11111_NS_001.xml', 'utf8')
      .replace(/<IdentificativoSdI>[^<]*<\/IdentificativoSdI>/,
               `<IdentificativoSdI>${sdiId}</IdentificativoSdI>`);

  it('REFUSES a receipt whose IdentificativoSdI belongs to another tenant', async () => {
    // Victim: a live submission with a known IdentificativoSdI.
    const victim = await seedTenant(h);
    const sub = await request(h.app).post('/api/v1/invoices')
      .set({ authorization: `Bearer ${victim.apiKey}` })
      .send({ sellerId: victim.sellerId, invoice: validInvoice() });
    const sdiId = `victim-${Date.now()}`;
    await withTenant(h.db, victim.tenantId, (tx) => tx.query(
      'UPDATE correlation_records SET identificativo_sdi = $2 WHERE submission_id = $1',
      [sub.body.submissionId, sdiId]));
    await withTenant(h.db, victim.tenantId, (tx) => tx.query(
      `UPDATE sdi_submissions SET state = 'transmitted' WHERE id = $1`,
      [sub.body.submissionId]));

    // Attacker: posts a forged NS for the victim's id, through their OWN token.
    const r = await post(inboundUrl, ns(sdiId));
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('quarantined');

    // The victim's invoice is UNTOUCHED — not rejected.
    const after = await withTenant(h.db, victim.tenantId, (tx) =>
      tx.query<{ state: string }>('SELECT state FROM sdi_submissions WHERE id = $1',
        [sub.body.submissionId]));
    expect(after.rows[0]!.state).toBe('transmitted');
    expect(after.rows[0]!.state).not.toBe('rejected');
  });

  it('still applies a receipt for the caller OWN tenant', async () => {
    const own = await request(h.app).post('/api/v1/invoices')
      .set({ authorization: `Bearer ${t.apiKey}` })
      .send({ sellerId: t.sellerId, invoice: validInvoice() });
    const sdiId = `own-${Date.now()}`;
    await withTenant(h.db, t.tenantId, (tx) => tx.query(
      'UPDATE correlation_records SET identificativo_sdi = $2 WHERE submission_id = $1',
      [own.body.submissionId, sdiId]));
    await withTenant(h.db, t.tenantId, (tx) => tx.query(
      `UPDATE sdi_submissions SET state = 'transmitted' WHERE id = $1`,
      [own.body.submissionId]));

    // The guard must not break the legitimate path it protects.
    const r = await post(inboundUrl, rc(sdiId));
    expect(r.body.status).toBe('applied');
  });
});
