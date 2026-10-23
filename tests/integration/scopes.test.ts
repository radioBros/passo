import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHarness, seedTenant, ADMIN_KEY, type Harness } from '../helpers/harness.ts';
import { SCOPES, DEFAULT_SCOPES, assertValidScopes } from '../../src/domain/apikey/scopes.ts';

/**
 * Scope enforcement (KEY-014).
 *
 * Scopes are the only thing between a stolen read-only key and the ability to
 * redirect a webhook or mint credentials. Two failure modes matter, and both
 * were real before these tests existed:
 *
 *   - The creation route accepted `scopes` and **dropped it**, so a caller
 *     asking for a read-only key silently received the full default set.
 *   - An unknown scope was stored happily, granting nothing while looking
 *     correct — producing a 403 much later with no obvious cause.
 */
let h: Harness;
let tenantId = '';
beforeAll(async () => {
  h = createHarness();
  tenantId = (await seedTenant(h)).tenantId;
});
afterAll(async () => { await h.close(); });

const admin = () => ({ authorization: `Bearer ${ADMIN_KEY}` });
const makeKey = (scopes?: string[]) =>
  request(h.app).post(`/api/v1/admin/tenants/${tenantId}/api-keys`).set(admin())
    .send({ name: 'k', ...(scopes ? { scopes } : {}) });

describe('scope catalogue', () => {
  it('accepts every catalogued scope', () => {
    expect(() => assertValidScopes([...SCOPES])).not.toThrow();
  });

  it('REFUSES an unknown scope and names the valid set', () => {
    expect(() => assertValidScopes(['webhook:write'])).toThrow(/unknown scope/);
    expect(() => assertValidScopes(['webhook:write'])).toThrow(/webhooks:write/);
  });

  it('defaults exclude key management — widening is a deliberate act', () => {
    expect(DEFAULT_SCOPES).not.toContain('keys:write');
    expect(DEFAULT_SCOPES).not.toContain('keys:read');
  });
});

describe('scope enforcement over HTTP', () => {
  it('HONOURS a requested scope list instead of silently widening it', async () => {
    const r = await makeKey(['invoices:read']);
    expect(r.status).toBe(201);
    const list = await request(h.app)
      .get(`/api/v1/admin/tenants/${tenantId}/api-keys`).set(admin());
    const row = list.body.data.find((k: { id: string }) => k.id === r.body.id);
    expect(row.scopes).toEqual(['invoices:read']);
  });

  it('rejects an unknown scope at creation, not at first use', async () => {
    const r = await makeKey(['webhook:write']);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/unknown scope/);
  });

  it('a read-only key CANNOT create a webhook', async () => {
    const k = await makeKey(['invoices:read']);
    const r = await request(h.app).post('/api/v1/webhooks')
      .set({ authorization: `Bearer ${k.body.key}` })
      .send({ callbackUrl: 'https://1.1.1.1/h' });
    expect(r.status).toBe(403);
  });

  /** An opaque 403 costs an integrator an afternoon. */
  it('NAMES the missing scope in the 403', async () => {
    const k = await makeKey(['invoices:read']);
    const r = await request(h.app).post('/api/v1/webhooks')
      .set({ authorization: `Bearer ${k.body.key}` })
      .send({ callbackUrl: 'https://1.1.1.1/h' });
    expect(r.body.error.code).toBe('ERR_AUTH_SCOPE');
    expect(r.body.error.message).toContain('webhooks:write');
  });

  it('a key WITH the scope succeeds', async () => {
    const k = await makeKey(['webhooks:write', 'webhooks:read']);
    const r = await request(h.app).post('/api/v1/webhooks')
      .set({ authorization: `Bearer ${k.body.key}` })
      .send({ callbackUrl: 'https://1.1.1.1/h' });
    expect(r.status).toBe(201);
  });

  it('read does NOT imply write, and write does not imply read', async () => {
    const readOnly = await makeKey(['webhooks:read']);
    const writeOnly = await makeKey(['webhooks:write']);
    const create = (key: string) => request(h.app).post('/api/v1/webhooks')
      .set({ authorization: `Bearer ${key}` }).send({ callbackUrl: 'https://1.1.1.1/h' });
    const list = (key: string) => request(h.app).get('/api/v1/webhooks')
      .set({ authorization: `Bearer ${key}` });
    expect((await create(readOnly.body.key)).status).toBe(403);
    expect((await list(writeOnly.body.key)).status).toBe(403);
    expect((await list(readOnly.body.key)).status).toBe(200);
    expect((await create(writeOnly.body.key)).status).toBe(201);
  });

  it('publishes the catalogue so an integrator can see what a key may hold', async () => {
    const k = await makeKey(['invoices:read']);
    const r = await request(h.app).get('/api/v1/scopes')
      .set({ authorization: `Bearer ${k.body.key}` });
    expect(r.body.data).toHaveLength(SCOPES.length);
    for (const s of r.body.data) expect(s.description.length).toBeGreaterThan(8);
  });
});

/**
 * Tenant suspension must stop authentication.
 *
 * `api_key_auth` originally joined `tenants` and filtered on
 * `status = 'active'`. A later migration rebuilt the view to add a column and
 * silently dropped the join — after which a SUSPENDED tenant kept
 * authenticating and kept transmitting invoices.
 *
 * Suspension is the operator's lever for non-payment, abuse and incident
 * response. A lever that does nothing is worse than none, because it is
 * believed.
 */
describe('tenant suspension', () => {
  const setStatus = (status: string) =>
    h.db.query('UPDATE tenants SET status = $2 WHERE id = $1', [tenantId, status]);

  it('a key stops working the moment its tenant is suspended', async () => {
    const k = await makeKey();
    const use = () => request(h.app).get('/api/v1/pending')
      .set({ authorization: `Bearer ${k.body.key}` });

    expect((await use()).status).toBe(200);
    await setStatus('suspended');
    expect((await use()).status).toBe(401);
    await setStatus('active');
    expect((await use()).status).toBe(200);
  });

  it('a DEACTIVATED tenant is refused too', async () => {
    const k = await makeKey();
    await setStatus('deactivated');
    const r = await request(h.app).get('/api/v1/pending')
      .set({ authorization: `Bearer ${k.body.key}` });
    expect(r.status).toBe(401);
    await setStatus('active');
  });

  it('the view enforces it, not the handler — no query can forget', async () => {
    const def = await h.db.query<{ d: string }>(
      "SELECT pg_get_viewdef('api_key_auth'::regclass, true) AS d");
    expect(def.rows[0]!.d).toMatch(/tenants/);
    expect(def.rows[0]!.d).toMatch(/active/);
  });
});
