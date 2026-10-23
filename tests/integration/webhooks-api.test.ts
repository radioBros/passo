import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHarness, seedTenant, type Harness } from '../helpers/harness.ts';
import { verifyWebhook, signWebhook } from '../../src/domain/webhook/security.ts';
import { WEBHOOK_EVENTS } from '../../src/domain/webhook/events.ts';

/**
 * Tenant-facing webhook management (WH-015…WH-017).
 *
 * Previously reachable only with the admin key, which meant a CRM could not
 * manage its own subscriptions — and could not see the delivery history, the
 * one surface that answers "why didn't my webhook arrive".
 */
let h: Harness;
let t = { apiKey: '', tenantId: '', sellerId: '' };
let other = { apiKey: '', tenantId: '', sellerId: '' };

beforeAll(async () => {
  h = createHarness();
  t = await seedTenant(h);
  other = await seedTenant(h);
});
afterAll(async () => { await h.close(); });

const auth = () => ({ authorization: `Bearer ${t.apiKey}` });
const create = (body: object = { callbackUrl: 'https://1.1.1.1/hook' }) =>
  request(h.app).post('/api/v1/webhooks').set(auth()).send(body);

describe('webhook subscriptions', () => {
  it('creates a subscription and returns the secret ONCE', async () => {
    const r = await create();
    expect(r.status).toBe(201);
    expect(r.body.secret).toMatch(/^whsec_/);
    expect(r.body.note).toMatch(/never shown again/i);
  });

  it('NEVER returns the secret again — only a prefix', async () => {
    const c = await create();
    const list = await request(h.app).get('/api/v1/webhooks').set(auth());
    const row = list.body.data.find((w: { id: string }) => w.id === c.body.id);
    expect(row.secret_prefix).toBeTruthy();
    // A secret retrievable after creation is not a secret.
    expect(JSON.stringify(row)).not.toContain(c.body.secret);
  });

  it('REFUSES an unknown event name and lists the valid set', async () => {
    const r = await create({ callbackUrl: 'https://1.1.1.1/h', events: ['invoice.delivred'] });
    expect(r.status).toBe(400);
    // A misspelled event is silently inert — it must fail while the author is here.
    expect(r.body.error.message).toMatch(/unknown webhook event/i);
    expect(r.body.error.message).toMatch(/invoice\.delivered/);
  });

  it('BLOCKS an SSRF callback at registration', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/',
                       'http://127.0.0.1:5432/', 'http://[::1]/']) {
      const r = await create({ callbackUrl: url });
      expect(r.status, url).toBe(400);
    }
  });

  it('lists only this tenant subscriptions', async () => {
    await create();
    const mine = await request(h.app).get('/api/v1/webhooks').set(auth());
    const theirs = await request(h.app).get('/api/v1/webhooks')
      .set({ authorization: `Bearer ${other.apiKey}` });
    const ids = new Set(mine.body.data.map((w: { id: string }) => w.id));
    for (const w of theirs.body.data) expect(ids.has(w.id)).toBe(false);
  });

  it('updates events and active state', async () => {
    const c = await create();
    const r = await request(h.app).patch(`/api/v1/webhooks/${c.body.id}`).set(auth())
      .send({ events: ['invoice.rejected'], active: false });
    expect(r.status).toBe(200);
    const list = await request(h.app).get('/api/v1/webhooks').set(auth());
    const row = list.body.data.find((w: { id: string }) => w.id === c.body.id);
    expect(row.events).toEqual(['invoice.rejected']);
    expect(row.active).toBe(false);
  });

  it('404s updating another tenant subscription', async () => {
    const c = await create();
    const r = await request(h.app).patch(`/api/v1/webhooks/${c.body.id}`)
      .set({ authorization: `Bearer ${other.apiKey}` }).send({ active: false });
    expect(r.status).toBe(404);
  });

  it('deletes a subscription', async () => {
    const c = await create();
    expect((await request(h.app).delete(`/api/v1/webhooks/${c.body.id}`).set(auth())).status)
      .toBe(204);
    expect((await request(h.app).delete(`/api/v1/webhooks/${c.body.id}`).set(auth())).status)
      .toBe(404);
  });

  it('publishes the event catalogue with meanings', async () => {
    const r = await request(h.app).get('/api/v1/webhook-events').set(auth());
    expect(r.body.count).toBe(WEBHOOK_EVENTS.length);
    const ns = r.body.data.find((e: { event: string }) => e.event === 'invoice.rejected');
    // The two contract details integrators miss most.
    expect(ns.terminal).toBe(true);
    expect(ns.legallyIssued).toBe(false);
    expect(ns.action).toBe('issue_new_invoice');
    const mc = r.body.data.find((e: { event: string }) => e.event === 'invoice.exception');
    expect(mc.legallyIssued).toBe(true);
    expect(mc.terminal).toBe(false);
  });
});

/**
 * WH-007 — rotation with a bounded overlap.
 *
 * Without an overlap, rotating is a coordinated outage: every delivery fails
 * verification until the receiver redeploys. That is why secrets never get
 * rotated, which defeats the point of having them.
 */
describe('secret rotation', () => {
  it('returns a NEW secret and states the overlap window', async () => {
    const c = await create();
    const r = await request(h.app).post(`/api/v1/webhooks/${c.body.id}/rotate-secret`)
      .set(auth()).send({});
    expect(r.status).toBe(200);
    expect(r.body.secret).toMatch(/^whsec_/);
    expect(r.body.secret).not.toBe(c.body.secret);
    expect(r.body.overlapHours).toBeGreaterThan(0);
  });

  it('records the overlap expiry so the old secret cannot live forever', async () => {
    const c = await create();
    await request(h.app).post(`/api/v1/webhooks/${c.body.id}/rotate-secret`)
      .set(auth()).send({ overlapHours: 1 });
    const list = await request(h.app).get('/api/v1/webhooks').set(auth());
    const row = list.body.data.find((w: { id: string }) => w.id === c.body.id);
    expect(new Date(row.previous_secret_expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('caps an absurd overlap request', async () => {
    const c = await create();
    const r = await request(h.app).post(`/api/v1/webhooks/${c.body.id}/rotate-secret`)
      .set(auth()).send({ overlapHours: 100000 });
    expect(r.body.overlapHours).toBeLessThanOrEqual(168);
  });

  /**
   * The header carries two `v1=` values during an overlap. A receiver parsing
   * it into a map keeps only the last, so one of the two secrets would always
   * fail — silently, for the whole window.
   */
  it('a DUAL signature verifies under BOTH the new and the old secret', () => {
    const at = Date.now();
    const body = '{"hello":"world"}';
    const dual = `${signWebhook(body, 'new-secret', at)},${
      signWebhook(body, 'old-secret', at).split(',')[1]}`;
    expect(verifyWebhook(body, dual, 'new-secret')).toBe(true);
    expect(verifyWebhook(body, dual, 'old-secret')).toBe(true);
    expect(verifyWebhook(body, dual, 'wrong-secret')).toBe(false);
  });

  it('a dual signature still rejects a tampered body', () => {
    const at = Date.now();
    const dual = `${signWebhook('{"a":1}', 'new', at)},${
      signWebhook('{"a":1}', 'old', at).split(',')[1]}`;
    expect(verifyWebhook('{"a":2}', dual, 'new')).toBe(false);
    expect(verifyWebhook('{"a":2}', dual, 'old')).toBe(false);
  });
});

describe('delivery history', () => {
  it('returns an empty list for a new subscription, with a null cursor', async () => {
    const c = await create();
    const r = await request(h.app).get(`/api/v1/webhooks/${c.body.id}/deliveries`).set(auth());
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
    expect(r.body.nextCursor).toBeNull();
  });

  it('is RLS-scoped — another tenant sees nothing', async () => {
    const c = await create();
    const r = await request(h.app).get(`/api/v1/webhooks/${c.body.id}/deliveries`)
      .set({ authorization: `Bearer ${other.apiKey}` });
    expect(r.body.data).toEqual([]);
  });

  it('clamps an oversized limit rather than honouring it', async () => {
    const c = await create();
    const r = await request(h.app)
      .get(`/api/v1/webhooks/${c.body.id}/deliveries?limit=99999`).set(auth());
    expect(r.status).toBe(200);
  });
});
