import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHarness, seedTenant, ADMIN_KEY, type Harness } from '../helpers/harness.ts';
import { withTenant } from '../../src/infra/db/pool.ts';

/**
 * Key rotation with a grace window (KEY-010 / KEY-011).
 *
 * Without a grace period, rotating is a coordinated outage — the moment the new
 * key exists, every request carrying the old one fails. So operators do not
 * rotate, which defeats the point of a rotatable credential.
 *
 * With one, BOTH keys work briefly and the old one announces its own deadline.
 */
let h: Harness;
let tenantId = '';

beforeAll(async () => {
  h = createHarness();
  tenantId = (await seedTenant(h)).tenantId;
});
afterAll(async () => { await h.close(); });

const admin = () => ({ authorization: `Bearer ${ADMIN_KEY}` });
const makeKey = () =>
  request(h.app).post(`/api/v1/admin/tenants/${tenantId}/api-keys`)
    .set(admin()).send({ name: 'rot' });
const rotate = (id: string) =>
  request(h.app).post(`/api/v1/admin/tenants/${tenantId}/api-keys/${id}/rotate`).set(admin());
const use = (key: string) =>
  request(h.app).get('/api/v1/pending').set({ authorization: `Bearer ${key}` });

describe('key rotation grace', () => {
  it('the OLD key keeps working after rotation', async () => {
    const first = await makeKey();
    await rotate(first.body.id);
    // If this 401'd, rotation would be an outage and nobody would rotate.
    expect((await use(first.body.key)).status).toBe(200);
  });

  it('the NEW key works too', async () => {
    const first = await makeKey();
    const second = await rotate(first.body.id);
    expect((await use(second.body.key)).status).toBe(200);
    expect(second.body.key).not.toBe(first.body.key);
  });

  it('the old key announces its own deadline', async () => {
    const first = await makeKey();
    await rotate(first.body.id);
    const r = await use(first.body.key);
    expect(r.headers['deprecation']).toBe('true');
    // Sunset gives the exact date, so a caller is not guessing.
    expect(new Date(r.headers['sunset']!).getTime()).toBeGreaterThan(Date.now());
    expect(r.headers['link']).toMatch(/rel="deprecation"/);
  });

  it('the NEW key carries no deprecation headers', async () => {
    const first = await makeKey();
    const second = await rotate(first.body.id);
    const r = await use(second.body.key);
    expect(r.headers['deprecation']).toBeUndefined();
  });

  it('COUNTS grace usage, so an operator can chase the caller', async () => {
    const first = await makeKey();
    await rotate(first.body.id);
    for (let i = 0; i < 3; i++) await use(first.body.key);

    /**
     * `markUsed` is deliberately fire-and-forget — nobody waits on a usage
     * counter, and awaiting it would put a write on the auth path of every
     * request. So poll rather than assume it has landed.
     */
    let uses = 0;
    for (let i = 0; i < 20 && uses < 3; i++) {
      const row = await withTenant(h.db, tenantId, (tx) => tx.query<{ grace_uses: number }>(
        'SELECT grace_uses FROM api_keys WHERE id = $1', [first.body.id]));
      uses = row.rows[0]!.grace_uses;
      if (uses < 3) await new Promise((r) => setTimeout(r, 50));
    }
    // Without the counter, "old key still in use" is invisible until the
    // window closes and someone's traffic stops.
    expect(uses).toBeGreaterThanOrEqual(3);
  });

  it('the old key STOPS once the window closes', async () => {
    const first = await makeKey();
    await rotate(first.body.id);
    await withTenant(h.db, tenantId, (tx) => tx.query(
      `UPDATE api_keys SET grace_expires_at = now() - interval '1 hour' WHERE id = $1`,
      [first.body.id]));
    // A grace period that never ends is a second live credential.
    expect((await use(first.body.key)).status).toBe(401);
  });

  it('rotation is a credential swap, NOT a permission change', async () => {
    const scoped = await request(h.app)
      .post(`/api/v1/admin/tenants/${tenantId}/api-keys`)
      .set(admin()).send({ name: 'scoped', scopes: ['invoices:read'] });
    const rotated = await rotate(scoped.body.id);
    const list = await request(h.app)
      .get(`/api/v1/admin/tenants/${tenantId}/api-keys`).set(admin());
    const row = list.body.data.find((k: { id: string }) => k.id === rotated.body.id);
    // Silently widening a key during rotation would be a privilege escalation
    // nobody asked for.
    expect(row.scopes).toEqual(['invoices:read']);
  });

  it('rotation does NOT extend the key own natural expiry', async () => {
    const k = await request(h.app)
      .post(`/api/v1/admin/tenants/${tenantId}/api-keys`)
      .set(admin()).send({ name: 'exp', expiresInDays: 2 });
    const before = await withTenant(h.db, tenantId, (tx) => tx.query<{ expires_at: Date }>(
      'SELECT expires_at FROM api_keys WHERE id = $1', [k.body.id]));
    await rotate(k.body.id);
    const after = await withTenant(h.db, tenantId, (tx) => tx.query<{ expires_at: Date }>(
      'SELECT expires_at FROM api_keys WHERE id = $1', [k.body.id]));
    // Reusing expires_at for the grace window silently extended the lifetime
    // of a key rotated near its natural expiry.
    expect(new Date(after.rows[0]!.expires_at).getTime())
      .toBe(new Date(before.rows[0]!.expires_at).getTime());
  });

  it('a REVOKED key stops immediately — revocation has no grace', async () => {
    const k = await makeKey();
    await request(h.app)
      .delete(`/api/v1/admin/tenants/${tenantId}/api-keys/${k.body.id}`).set(admin());
    // Revocation is the incident-response tool; a grace period would defeat it.
    expect((await use(k.body.key)).status).toBe(401);
  });
});
