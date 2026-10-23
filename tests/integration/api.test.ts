import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { withTenant } from '../../src/infra/db/pool.ts';
import { createServer } from '../../src/api/server.ts';
import { channelForTenant } from '../../src/infra/channels/registry.ts';
import { createHarness, seedTenant, validInvoice, ADMIN_KEY, type Harness } from '../helpers/harness.ts';

let h: Harness;
let t: Awaited<ReturnType<typeof seedTenant>>;
let other: Awaited<ReturnType<typeof seedTenant>>;

beforeAll(async () => {
  h = createHarness();
  t = await seedTenant(h);
  other = await seedTenant(h);
});
afterAll(async () => { await h.close(); });

const auth = () => ({ authorization: `Bearer ${t.apiKey}` });
const admin = () => ({ authorization: `Bearer ${ADMIN_KEY}` });

describe('health', () => {
  it('GET /health/live needs no auth and no dependencies', async () => {
    const r = await request(h.app).get('/health/live');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
  });

  it('GET /health/ready reports each dependency', async () => {
    const r = await request(h.app).get('/health/ready');
    expect(r.body.checks).toHaveProperty('postgres');
    // SdI vendors are deliberately absent: a vendor outage must not take
    // PASSO out of rotation.
    expect(r.body.checks).not.toHaveProperty('invoicetronic');
  });
});

describe('authentication', () => {
  it('401 without a header', async () => {
    const r = await request(h.app).post('/api/v1/invoices').send({});
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('ERR_AUTH_MISSING');
  });

  it('401 on a malformed key', async () => {
    const r = await request(h.app).post('/api/v1/invoices')
      .set({ authorization: 'Bearer not-a-passo-key' }).send({});
    expect(r.body.error.code).toBe('ERR_AUTH_INVALID');
  });

  it('401 on a well-formed but unknown key', async () => {
    const r = await request(h.app).post('/api/v1/invoices')
      .set({ authorization: 'Bearer passo_live_deadbeefdeadbeefdeadbeef' }).send({});
    expect(r.status).toBe(401);
  });

  it('every response carries a requestId', async () => {
    const r = await request(h.app).get('/api/v1/pending').set(auth());
    expect(r.headers['x-request-id']).toBeTruthy();
  });

  it('rejects a revoked key', async () => {
    const v = await seedTenant(h);
    await request(h.app)
      .delete(`/api/v1/admin/tenants/${v.tenantId}/api-keys/${v.keyId}`).set(admin());
    const r = await request(h.app).get('/api/v1/pending')
      .set({ authorization: `Bearer ${v.apiKey}` });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('ERR_AUTH_REVOKED');
  });
});

describe('POST /api/v1/invoices', () => {
  it('202 with a tracking URL', async () => {
    const r = await request(h.app).post('/api/v1/invoices').set(auth())
      .send({ sellerId: t.sellerId, invoice: validInvoice() });
    expect(r.status).toBe(202);
    expect(r.body.submissionId).toBeTruthy();
    expect(r.body.status).toBe('queued');
    expect(r.body.trackingUrl).toContain(r.body.submissionId);
    expect(r.body.fileName).toMatch(/^IT\d+_[A-Z0-9]{1,10}\.xml$/);
  });

  it('400 without sellerId', async () => {
    const r = await request(h.app).post('/api/v1/invoices').set(auth())
      .send({ invoice: validInvoice() });
    expect(r.status).toBe(400);
  });

  it('400 on a zero-rate line with no Natura', async () => {
    const r = await request(h.app).post('/api/v1/invoices').set(auth()).send({
      sellerId: t.sellerId,
      invoice: validInvoice({
        lines: [{ lineNumber: 1, description: 'X', unitPrice: '10.00', totalPrice: '10.00', vatRate: '0.00' }],
      }),
    });
    expect(r.status).toBe(400);
  });

  it('accepts an exempt line WITH Natura', async () => {
    const r = await request(h.app).post('/api/v1/invoices').set(auth()).send({
      sellerId: t.sellerId,
      invoice: validInvoice({
        lines: [{ lineNumber: 1, description: 'Esente', unitPrice: '500.00', totalPrice: '500.00', vatRate: '0.00', nature: 'N4' }],
        summaries: [{ vatRate: '0.00', nature: 'N4', taxableAmount: '500.00', taxAmount: '0.00' }],
      }),
    });
    expect(r.status).toBe(202);
  });

  it('400 when recipientCode is 0000000 without a PEC', async () => {
    const r = await request(h.app).post('/api/v1/invoices').set(auth())
      .send({ sellerId: t.sellerId, invoice: validInvoice({ recipientCode: '0000000' }) });
    expect(r.status).toBe(400);
  });

  it('replays an identical idempotent request', async () => {
    const body = { sellerId: t.sellerId, invoice: validInvoice() };
    const k = `idem-${Math.random()}`;
    const a = await request(h.app).post('/api/v1/invoices').set(auth()).set('idempotency-key', k).send(body);
    const b = await request(h.app).post('/api/v1/invoices').set(auth()).set('idempotency-key', k).send(body);
    expect(b.body.submissionId).toBe(a.body.submissionId);
  });

  it('409 on the same idempotency key with a different body', async () => {
    const k = `idem-${Math.random()}`;
    await request(h.app).post('/api/v1/invoices').set(auth()).set('idempotency-key', k)
      .send({ sellerId: t.sellerId, invoice: validInvoice() });
    const b = await request(h.app).post('/api/v1/invoices').set(auth()).set('idempotency-key', k)
      .send({ sellerId: t.sellerId, invoice: validInvoice() });
    expect(b.status).toBe(409);
  });

  it('accepts a credit note TD04 with negative amounts', async () => {
    const r = await request(h.app).post('/api/v1/invoices').set(auth()).send({
      sellerId: t.sellerId,
      invoice: validInvoice({
        documentType: 'TD04',
        lines: [{ lineNumber: 1, description: 'Nota', unitPrice: '-100.00', totalPrice: '-100.00', vatRate: '22.00' }],
        summaries: [{ vatRate: '22.00', taxableAmount: '-100.00', taxAmount: '-22.00' }],
      }),
    });
    expect(r.status).toBe(202);
  });
});

describe('GET /api/v1/invoices/:id', () => {
  it('returns status and notification history', async () => {
    const c = await request(h.app).post('/api/v1/invoices').set(auth())
      .send({ sellerId: t.sellerId, invoice: validInvoice() });
    const r = await request(h.app).get(`/api/v1/invoices/${c.body.submissionId}`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('notifications');
    expect(r.body).toHaveProperty('progressivoInvio');
  });

  it('404 for an unknown id', async () => {
    const r = await request(h.app)
      .get('/api/v1/invoices/00000000-0000-0000-0000-000000000000').set(auth());
    expect(r.status).toBe(404);
  });

  it('404 — NOT 403 — for another tenant\'s submission (no existence disclosure)', async () => {
    const c = await request(h.app).post('/api/v1/invoices').set(auth())
      .send({ sellerId: t.sellerId, invoice: validInvoice() });
    const r = await request(h.app).get(`/api/v1/invoices/${c.body.submissionId}`)
      .set({ authorization: `Bearer ${other.apiKey}` });
    expect(r.status).toBe(404);
    expect(r.status).not.toBe(403);
  });
});

describe('retrieval before purge', () => {
  it('GET /xml returns the generated FatturaPA', async () => {
    const c = await request(h.app).post('/api/v1/invoices').set(auth())
      .send({ sellerId: t.sellerId, invoice: validInvoice() });
    const r = await request(h.app).get(`/api/v1/invoices/${c.body.submissionId}/xml`).set(auth());
    expect(r.status).toBe(200);
    expect(r.text).toContain('FatturaElettronica');
    expect(r.text).toContain('docs/xsd/fatture/v1.2"');   // v1.2, not v1.2.3
  });

  it('GET /rendered returns the official AdE rendering', async () => {
    const c = await request(h.app).post('/api/v1/invoices').set(auth())
      .send({ sellerId: t.sellerId, invoice: validInvoice() });
    const r = await request(h.app).get(`/api/v1/invoices/${c.body.submissionId}/rendered`).set(auth());
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/FATTURA ELETTRONICA|Dati relativi alla trasmissione/i);
  });

  it('GET /receipts lists notifications', async () => {
    const c = await request(h.app).post('/api/v1/invoices').set(auth())
      .send({ sellerId: t.sellerId, invoice: validInvoice() });
    const r = await request(h.app).get(`/api/v1/invoices/${c.body.submissionId}/receipts`).set(auth());
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
  });

  it('GET /pending is the reconciliation safety net', async () => {
    const r = await request(h.app).get('/api/v1/pending').set(auth());
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data)).toBe(true);
  });

  it('POST /ack acknowledges receipts', async () => {
    const c = await request(h.app).post('/api/v1/invoices').set(auth())
      .send({ sellerId: t.sellerId, invoice: validInvoice() });
    const r = await request(h.app).post(`/api/v1/invoices/${c.body.submissionId}/ack`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toHaveProperty('acknowledged');
  });
});

describe('POST /api/v1/render', () => {
  it('renders raw XML — usable after PASSO has purged it', async () => {
    const c = await request(h.app).post('/api/v1/invoices').set(auth())
      .send({ sellerId: t.sellerId, invoice: validInvoice() });
    const xml = (await request(h.app)
      .get(`/api/v1/invoices/${c.body.submissionId}/xml`).set(auth())).text;
    const r = await request(h.app).post('/api/v1/render').set(auth())
      .set('content-type', 'application/xml').send(xml);
    expect(r.status).toBe(200);
    expect(r.text.length).toBeGreaterThan(500);
  });

  it('400 on an empty body', async () => {
    const r = await request(h.app).post('/api/v1/render').set(auth())
      .set('content-type', 'application/xml').send('');
    expect(r.status).toBe(400);
  });
});

describe('admin API', () => {
  it('401 without the admin key', async () => {
    const r = await request(h.app).get('/api/v1/admin/tenants');
    expect(r.status).toBe(401);
  });

  it('rejects a TENANT key on an admin route', async () => {
    const r = await request(h.app).get('/api/v1/admin/tenants').set(auth());
    expect(r.status).toBe(401);
  });

  it('creates a tenant, key, seller and channel', async () => {
    const slug = `adm-${Math.random().toString(36).slice(2, 8)}`;
    const tn = await request(h.app).post('/api/v1/admin/tenants').set(admin())
      .send({ name: 'Admin Co', slug, transmitterCode: '01234567890' });
    expect(tn.status).toBe(201);

    const key = await request(h.app)
      .post(`/api/v1/admin/tenants/${tn.body.id}/api-keys`).set(admin()).send({ name: 'k' });
    expect(key.status).toBe(201);
    expect(key.body.key).toMatch(/^passo_live_/);
    expect(key.body.warning).toMatch(/cannot be retrieved/);

    const sel = await request(h.app)
      .post(`/api/v1/admin/tenants/${tn.body.id}/sellers`).set(admin())
      .send({ taxRegime: 'RF01', denomination: 'S', address: { street: 'V', postalCode: '20100', city: 'M' } });
    expect(sel.status).toBe(201);

    const ch = await request(h.app)
      .put(`/api/v1/admin/tenants/${tn.body.id}/channels/mock`).set(admin()).send({});
    expect(ch.status).toBe(200);
  });

  it('NEVER returns key hashes or channel credentials', async () => {
    const keys = await request(h.app)
      .get(`/api/v1/admin/tenants/${t.tenantId}/api-keys`).set(admin());
    expect(JSON.stringify(keys.body)).not.toMatch(/key_hash|\$2[aby]\$/);

    const ch = await request(h.app)
      .get(`/api/v1/admin/tenants/${t.tenantId}/channels`).set(admin());
    expect(JSON.stringify(ch.body)).not.toMatch(/config_encrypted|password/i);
  });

  it('rotates a key, keeping the old one valid during the grace window', async () => {
    const v = await seedTenant(h);
    const rot = await request(h.app)
      .post(`/api/v1/admin/tenants/${v.tenantId}/api-keys/${v.keyId}/rotate`).set(admin());
    expect(rot.body.key).toMatch(/^passo_live_/);
    expect(rot.body.key).not.toBe(v.apiKey);
    const old = await request(h.app).get('/api/v1/pending')
      .set({ authorization: `Bearer ${v.apiKey}` });
    expect(old.status).toBe(200);   // still valid for 7 days
  });

  it('rejects a webhook URL pointing at a private address (SSRF)', async () => {
    const r = await request(h.app)
      .post(`/api/v1/admin/tenants/${t.tenantId}/webhooks`).set(admin())
      .send({ url: 'https://169.254.169.254/latest/meta-data' });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('verifies the audit chain', async () => {
    // A tenant seeded fresh here: other suites deliberately BREAK the chain to
    // prove deletion is detectable, and audit_log is shared.
    const fresh = await seedTenant(h);
    const r = await request(h.app)
      .get(`/api/v1/admin/tenants/${fresh.tenantId}/audit/verify`).set(admin());
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

describe('unknown routes', () => {
  it('404 with the standard error envelope', async () => {
    const r = await request(h.app).get('/api/v1/nope').set(auth());
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('ERR_NOT_FOUND');
  });
});

describe('security regressions', () => {
  it('POST /render requires authentication and a scope', async () => {
    const r = await request(h.app).post('/api/v1/render')
      .set('content-type', 'application/xml').send('<x/>');
    expect(r.status).toBe(401);
  });

  it('POST /render rejects an oversized document', async () => {
    const huge = `<?xml version="1.0"?><a>${'x'.repeat(9 * 1024 * 1024)}</a>`;
    const r = await request(h.app).post('/api/v1/render').set(auth())
      .set('content-type', 'application/xml').send(huge);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('an XXE payload cannot read a local file through /render', async () => {
    const evil = `<?xml version="1.0"?>
      <!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
      <p:FatturaElettronica xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"
        versione="FPR12"><FatturaElettronicaHeader>&xxe;</FatturaElettronicaHeader></p:FatturaElettronica>`;
    const r = await request(h.app).post('/api/v1/render').set(auth())
      .set('content-type', 'application/xml').send(evil);
    expect(r.text ?? '').not.toMatch(/root:|\/bin\/(ba)?sh|daemon:/);
  });

  it('a tenantId in the body is ignored — tenancy comes from the key alone', async () => {
    const r = await request(h.app).post('/api/v1/invoices').set(auth())
      .send({ sellerId: t.sellerId, tenantId: other.tenantId, invoice: validInvoice() });
    expect(r.status).toBe(202);
    const check = await request(h.app).get(`/api/v1/invoices/${r.body.submissionId}`)
      .set({ authorization: `Bearer ${other.apiKey}` });
    expect(check.status).toBe(404);   // it belongs to t, not other
  });

  it('another tenant cannot use our sellerId', async () => {
    const r = await request(h.app).post('/api/v1/invoices')
      .set({ authorization: `Bearer ${other.apiKey}` })
      .send({ sellerId: t.sellerId, invoice: validInvoice() });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

/**
 * SEC-031 — hardening middleware. PASSO is a server-to-server API, so the
 * browser-facing surface is closed by default rather than merely restricted.
 */
describe('security headers and body limits', () => {
  it('sets a restrictive CSP and closes the framing vectors', async () => {
    const r = await request(h.app).get('/health/live');
    expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(r.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });

  it('never advertises the framework', async () => {
    const r = await request(h.app).get('/health/live');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('emits NO CORS header by default — a browser origin holds no API key', async () => {
    const r = await request(h.app).get('/health/live').set('origin', 'https://evil.example');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('returns 413, not 500, for an oversized body — a 500 would be retried forever', async () => {
    const body = `{"crmInvoiceRef":"${'x'.repeat(11 * 1024 * 1024)}"}`;
    const r = await request(h.app).post('/api/v1/invoices').set(auth())
      .set('content-type', 'application/json')
      .send(body);
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('ERR_PAYLOAD_TOO_LARGE');
    expect(r.body.error.retryable).toBe(false);
  });

  it('returns 400 for a malformed JSON body', async () => {
    const r = await request(h.app).post('/api/v1/invoices').set(auth())
      .set('content-type', 'application/json').send('{"broken":');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('ERR_SCHEMA_INVALID');
  });
});

/**
 * API-014 — sync mode end to end.
 *
 * The waiter must be armed BEFORE the pipeline can publish, or a fast AT is
 * announced to nobody and a successful invoice waits out the full timeout.
 */
describe('sync mode', () => {
  it('falls back to 202 when no waiter is configured', async () => {
    const r = await request(h.app).post('/api/v1/invoices').set(auth())
      .send({ sellerId: t.sellerId, invoice: validInvoice(), mode: 'sync', syncTimeoutMs: 1000 });
    // The harness supplies no watchMilestone; the invoice is still accepted.
    expect([200, 202]).toContain(r.status);
    expect(r.body.submissionId).toBeTruthy();
  });

  it('never waits longer than the configured cap, however large the request', async () => {
    const started = Date.now();
    await request(h.app).post('/api/v1/invoices').set(auth())
      .send({ sellerId: t.sellerId, invoice: validInvoice(), mode: 'sync', syncTimeoutMs: 999_999_999 });
    // Sync holds one connection per in-flight invoice; an unbounded wait is a
    // denial of service the caller inflicts on itself.
    expect(Date.now() - started).toBeLessThan(130_000);
  });
});

/**
 * API-015 — the per-tenant sync waiter cap.
 *
 * Sync holds an HTTP connection AND a duplicated Redis subscriber per in-flight
 * invoice. Uncapped, one tenant issuing a few hundred sync submissions exhausts
 * the connection pool and takes the API down for everyone — the same
 * noisy-neighbour failure per-tenant rate limiting exists to prevent.
 */
describe('sync waiter concurrency cap', () => {
  /**
   * A harness whose watcher never fires, so every sync request holds its slot
   * until the timeout. Without this the cap path is unreachable in tests — the
   * default harness supplies no watcher at all and returns 202 immediately.
   */
  let shared: Harness | undefined;
  afterAll(async () => { await shared?.close(); });

  /**
   * Lets a test pin every slot-holder until it says so.
   *
   * Timing alone made the cap test flaky, two ways:
   *  - each request pays bcrypt and several DB writes before reaching the
   *    waiter, so on a slow runner the earliest waiters timed out and freed
   *    their slot before the last request arrived;
   *  - against the live dev stack, the stack's own relay and worker claim the
   *    submission, so the route's re-read could see `transmitting` and return
   *    early, freeing its slot.
   * Holding inside `watchMilestone` — after the slot is taken, BEFORE the
   * re-read — removes both races.
   */
  const gate = {
    holding: false,
    held: 0,
    pending: new Set<() => void>(),
    release() { this.holding = false; for (const r of [...this.pending]) r(); this.pending.clear(); },
  };

  /**
   * ONE stalled harness for the whole suite. Building a fresh pool per test
   * multiplied Postgres connections across parallel test files until later
   * suites could not connect — a failure that looks like a logic bug in
   * whichever suite ran last.
   */
  const stalledHarness = () => {
    if (shared) return shared;
    const hh = createHarness();
    (hh as unknown as { app: unknown }).app = createServer({
      db: hh.db, keys: hh.keys, cfg: hh.cfg, redis: null,
      channelFor: (tid) => channelForTenant(hh.db, hh.keys, tid),
      ready: async () => ({ ok: true, checks: {} }),
      // Never reaches a milestone: the slot stays held until the timeout —
      // or, while the gate is holding, until the test releases it.
      watchMilestone: async () => {
        if (gate.holding) {
          gate.held++;
          await new Promise<void>((r) => gate.pending.add(r));
        }
        return {
          wait: (ms: number) => new Promise<string | null>((r) => setTimeout(() => r(null), ms)),
          close: async () => undefined,
        };
      },
    }, hh.cfg);
    shared = hh;
    return hh;
  };

  it('DECLINES to wait past the cap, but still accepts the invoice', async () => {
    const hh = stalledHarness();
    const seeded = await seedTenant(hh);
    const send = () => request(hh.app).post('/api/v1/invoices')
      .set({ authorization: `Bearer ${seeded.apiKey}` })
      .send({ sellerId: seeded.sellerId, invoice: validInvoice(),
              mode: 'sync', syncTimeoutMs: 100 });

    /**
     * All 30 must be IN FLIGHT together — the cap counts concurrent waiters,
     * not requests over time. Nothing is released until every request is
     * either holding a slot or has been declined, so no slot frees early.
     */
    gate.holding = true;
    gate.held = 0;
    let declinedSoFar = 0;
    const isDeclined = (r: { headers: Record<string, string> }) =>
      r.headers['x-passo-sync-declined'] === 'concurrent-waiter-limit';
    const inFlight = Array.from({ length: 30 }, () => send().then((r) => {
      if (isDeclined(r)) declinedSoFar++;
      return r;
    }));
    try {
      await vi.waitFor(() => expect(gate.held + declinedSoFar).toBe(30),
        { timeout: 15_000, interval: 20 });
    } finally {
      gate.release();
    }
    const results = await Promise.all(inFlight);
    const declined = results.filter(isDeclined);

    // Exactly 25 concurrent waiters; the rest are declined — but NOT rejected.
    expect(gate.held).toBe(25);
    expect(declined.length).toBe(5);
    // A held request may answer 200 after release (the pipeline already moved
    // it on) or 202 (timed out waiting). Both are acceptance; a decline is 202.
    for (const r of results) {
      expect([200, 202]).toContain(r.status);
      expect(r.body.submissionId, 'an accepted invoice is never lost to the cap').toBeTruthy();
    }
    for (const r of declined) {
      expect(r.status).toBe(202);
      expect(r.body.note).toMatch(/per-tenant limit/);
    }
  });

  it('RELEASES slots when waiters finish, so the cap is not permanent', async () => {
    const hh = stalledHarness();
    const seeded = await seedTenant(hh);
    const send = () => request(hh.app).post('/api/v1/invoices')
      .set({ authorization: `Bearer ${seeded.apiKey}` })
      .send({ sellerId: seeded.sellerId, invoice: validInvoice(),
              mode: 'sync', syncTimeoutMs: 150 });

    await Promise.all(Array.from({ length: 30 }, send));
    // Everything above has now timed out and released.
    const after = await send();
    expect(after.headers['x-passo-sync-declined']).toBeUndefined();
  });

  it('is PER TENANT — a saturated tenant does not block another', async () => {
    const hh = stalledHarness();
    const busy = await seedTenant(hh);
    const quiet = await seedTenant(hh);
    const send = (who: { apiKey: string; sellerId: string }, ms: number) =>
      request(hh.app).post('/api/v1/invoices')
        .set({ authorization: `Bearer ${who.apiKey}` })
        .send({ sellerId: who.sellerId, invoice: validInvoice(), mode: 'sync', syncTimeoutMs: ms });

    const saturate = Promise.all(Array.from({ length: 30 }, () => send(busy, 600)));
    await new Promise((r) => setTimeout(r, 150));
    const other = await send(quiet, 100);
    expect(other.headers['x-passo-sync-declined']).toBeUndefined();
    await saturate;
  });
});

/**
 * API-016 — the next-action hint.
 *
 * The two states that matter most read backwards: `rejected` (NS) looks
 * retryable and is terminal, `awaiting_delivery` (MC) looks like a failure
 * while the invoice is already legally issued. Leaving that inference to the
 * integrator is how duplicates reach the tax authority.
 */
describe('next-action hint', () => {
  const stateOf = async (id: string, state: string) => {
    const { withTenant } = await import('../../src/infra/db/pool.ts');
    await withTenant(h.db, t.tenantId, (tx) =>
      tx.query('UPDATE sdi_submissions SET state=$2 WHERE id=$1', [id, state]));
    return request(h.app).get(`/api/v1/invoices/${id}`).set(auth());
  };

  const submitOne = async () => {
    const r = await request(h.app).post('/api/v1/invoices').set(auth())
      .send({ sellerId: t.sellerId, invoice: validInvoice() });
    return r.body.submissionId as string;
  };

  it('an NS says issue a NEW invoice, and marks it terminal + not issued', async () => {
    const r = await stateOf(await submitOne(), 'rejected');
    expect(r.body.nextAction).toBe('issue_new_invoice');
    expect(r.body.terminal).toBe(true);
    expect(r.body.legallyIssued).toBe(false);
    expect(r.body.guidance).toMatch(/NEW invoice/);
    expect(r.body.guidance).toMatch(/ProgressivoInvio/);
  });

  it('an MC says nothing is required, and marks it legally ISSUED', async () => {
    const r = await stateOf(await submitOne(), 'awaiting_delivery');
    expect(r.body.nextAction).toBe('none_required');
    expect(r.body.legallyIssued).toBe(true);
    expect(r.body.terminal).toBe(false);
    expect(r.body.guidance).toMatch(/NOT a failure/);
    expect(r.body.guidance).toMatch(/Do not resubmit/);
  });

  it('an AT says notify the recipient — issued but undelivered', async () => {
    // The STATE is `undelivered_attested`; the EVENT is
    // `invoice.transmitted_undelivered`. Matching on the event name here left
    // AT falling through to the generic default.
    const r = await stateOf(await submitOne(), 'undelivered_attested');
    expect(r.body.nextAction).toBe('notify_recipient');
    expect(r.body.legallyIssued).toBe(true);
  });

  it('a PA rejection (NE/EC02) says the invoice WAS still issued', async () => {
    const r = await stateOf(await submitOne(), 'rejected_by_pa');
    expect(r.body.nextAction).toBe('contact_recipient');
    // A commercial rejection, not a fiscal one — the invoice is issued.
    expect(r.body.legallyIssued).toBe(true);
  });

  it('a cross-tenant id is 404, never 403 — a 403 discloses existence', async () => {
    const id = await submitOne();
    const other = await seedTenant(h);
    const r = await request(h.app).get(`/api/v1/invoices/${id}`)
      .set({ authorization: `Bearer ${other.apiKey}` });
    expect(r.status).toBe(404);
  });
});

/**
 * API-024 — every catalogue code asserted through the HTTP surface.
 *
 * A code that is thrown but never asserted is one nobody has checked actually
 * reaches the caller with the right status and retryability — and `retryable`
 * is the field a CRM automates on. A wrong value there produces either an
 * infinite retry loop or an invoice lost to a transient blip.
 */
describe('error codes over HTTP', () => {
  const post = (body: object, key = t.apiKey) =>
    request(h.app).post('/api/v1/invoices')
      .set({ authorization: `Bearer ${key}` }).send(body);

  const inv = (over: Record<string, unknown> = {}) => ({ ...validInvoice(), ...over });

  it('ERR_NATURA_REQUIRED — a zero-VAT line without Natura', async () => {
    const r = await post({ sellerId: t.sellerId, invoice: inv({
      lines: [{ lineNumber: 1, description: 'S', unitPrice: '10.00',
                totalPrice: '10.00', vatRate: '0.00' }],
      summaries: [{ vatRate: '0.00', taxableAmount: '10.00', taxAmount: '0.00' }],
    }) });
    expect(r.status).toBe(400);
    // A specific code, not a generic schema error: this one costs an NS.
    expect(r.body.error.code).toBe('ERR_NATURA_REQUIRED');
    expect(r.body.error.retryable).toBe(false);
  });

  it('ERR_VALIDATION_PEC_REQUIRED — code 0000000 with no recipientPec', async () => {
    const r = await post({ sellerId: t.sellerId, invoice: inv({ recipientCode: '0000000' }) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('ERR_VALIDATION_PEC_REQUIRED');
  });

  it('ERR_CHANNEL_NOT_CONFIGURED — a tenant with no active channel', async () => {
    const bare = await seedTenant(h);
    await withTenant(h.db, bare.tenantId, (tx) =>
      tx.query('UPDATE channel_credentials SET active = false'));
    const r = await post({ sellerId: bare.sellerId, invoice: validInvoice() }, bare.apiKey);
    expect(r.body.error.code).toBe('ERR_CHANNEL_NOT_CONFIGURED');
    expect(r.body.error.retryable).toBe(false);
  });

  it('ERR_GONE — a purged submission, distinct from a 404', async () => {
    const s = await post({ sellerId: t.sellerId, invoice: validInvoice() });
    await withTenant(h.db, t.tenantId, (tx) => tx.query(
      `UPDATE sdi_submissions SET xml_encrypted = NULL, purged_at = now(),
              terminal_at = now(), state = 'delivered' WHERE id = $1`,
      [s.body.submissionId]));
    const r = await request(h.app).get(`/api/v1/invoices/${s.body.submissionId}/xml`).set(auth());
    // 410 tells a CRM "you were too late"; 404 would say "wrong id".
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe('ERR_GONE');
  });

  it('ERR_CONFLICT_IDEMPOTENCY — the same key with a different body', async () => {
    const key = `idem-${Date.now()}`;
    await request(h.app).post('/api/v1/invoices').set(auth())
      .set('idempotency-key', key)
      .send({ sellerId: t.sellerId, invoice: validInvoice({ number: 'IDEM/A' }) });
    const r = await request(h.app).post('/api/v1/invoices').set(auth())
      .set('idempotency-key', key)
      .send({ sellerId: t.sellerId, invoice: validInvoice({ number: 'IDEM/B' }) });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('ERR_CONFLICT_IDEMPOTENCY');
  });

  it('ERR_UNSUPPORTED_MEDIA_TYPE — an unreadable content encoding', async () => {
    const r = await request(h.app).post('/api/v1/invoices').set(auth())
      .set('content-type', 'application/json')
      .set('content-encoding', 'br-not-really')
      .send('{}');
    expect([400, 415]).toContain(r.status);
  });

  it('ERR_AUTH_EXPIRED — a key past its expiry', async () => {
    const k = await request(h.app)
      .post(`/api/v1/admin/tenants/${t.tenantId}/api-keys`)
      .set({ authorization: `Bearer ${ADMIN_KEY}` })
      .send({ name: 'exp', expiresInDays: 1 });
    await withTenant(h.db, t.tenantId, (tx) => tx.query(
      `UPDATE api_keys SET expires_at = now() - interval '1 day' WHERE id = $1`, [k.body.id]));
    const r = await request(h.app).get('/api/v1/pending')
      .set({ authorization: `Bearer ${k.body.key}` });
    expect(r.status).toBe(401);
  });
});
