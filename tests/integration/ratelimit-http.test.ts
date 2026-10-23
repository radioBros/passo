import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHarness, seedTenant, type Harness } from '../helpers/harness.ts';

/**
 * API-004 through the REAL HTTP stack.
 *
 * The rest of the suite raises the budget to 100k so a long test run does not
 * trip its own limiter — which means nothing else exercises rate limiting
 * end-to-end. This harness sets a deliberately tiny budget so the middleware is
 * tested where it actually runs: through Express, with real auth, on real
 * tenants.
 *
 * The property that matters is not "requests get blocked" but "one noisy CRM
 * cannot starve another" — the noisy-neighbour guarantee that makes a shared
 * instance safe to sell.
 */
let h: Harness;
let a = { apiKey: '', tenantId: '', sellerId: '' };
let b = { apiKey: '', tenantId: '', sellerId: '' };

beforeAll(async () => {
  h = createHarness({ RATE_LIMIT_POINTS: '3', RATE_LIMIT_DURATION_SEC: '60' });
  a = await seedTenant(h);
  b = await seedTenant(h);
});
afterAll(async () => { await h.close(); });

const get = (key: string) =>
  request(h.app).get('/api/v1/pending').set({ authorization: `Bearer ${key}` });

describe('rate limiting over HTTP', () => {
  it('allows requests within the budget', async () => {
    expect((await get(a.apiKey)).status).toBe(200);
  });

  it('returns 429 with Retry-After once the budget is spent', async () => {
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await get(a.apiKey)).status;
    expect(last).toBe(429);
    const blocked = await get(a.apiKey);
    expect(blocked.headers['retry-after']).toBeTruthy();
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('reports the catalogue code, not a bare status', async () => {
    for (let i = 0; i < 8; i++) await get(a.apiKey);
    expect((await get(a.apiKey)).body.error.code).toBe('ERR_RATE_LIMITED');
  });

  /**
   * The whole point of per-tenant limiting: tenant A has just been throttled
   * to a standstill above, and tenant B must be entirely unaffected.
   */
  it('IS PER-TENANT — a throttled tenant does not starve another', async () => {
    for (let i = 0; i < 8; i++) await get(a.apiKey);
    expect((await get(a.apiKey)).status).toBe(429);
    expect((await get(b.apiKey)).status).toBe(200);
  });

  it('emits accurate budget headers while under the limit', async () => {
    const fresh = await seedTenant(h);
    const first = await get(fresh.apiKey);
    expect(first.headers['x-ratelimit-limit']).toBe('3');
    expect(first.headers['x-ratelimit-remaining']).toBe('2');
    const second = await get(fresh.apiKey);
    expect(second.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('sets a reset hint so a client knows when to come back', async () => {
    const fresh = await seedTenant(h);
    const r = await get(fresh.apiKey);
    expect(Number(r.headers['x-ratelimit-reset'])).toBeGreaterThan(0);
  });
});
