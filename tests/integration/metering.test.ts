import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHarness, seedTenant, ADMIN_KEY, type Harness } from '../helpers/harness.ts';
import { UsageMeter } from '../../src/api/middleware/metering.ts';
import { withTenant } from '../../src/infra/db/pool.ts';

/**
 * Usage metering (KEY-003 / KEY-017 / KEY-019).
 *
 * Buffered, never written on the request path: a per-request INSERT would make
 * metering the slowest thing in a handler that otherwise does one indexed read,
 * and would put invoice submission behind a write nobody is waiting for.
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

const meterOf = () =>
  (h.app as unknown as { usageMeter: UsageMeter }).usageMeter;

const usage = (tenantId: string, qs = '') =>
  request(h.app).get(`/api/v1/admin/tenants/${tenantId}/usage${qs}`)
    .set({ authorization: `Bearer ${ADMIN_KEY}` });

describe('usage metering', () => {
  it('records requests once flushed', async () => {
    for (let i = 0; i < 3; i++) {
      await request(h.app).get('/api/v1/pending')
        .set({ authorization: `Bearer ${t.apiKey}` });
    }
    await meterOf().flush();
    const r = await usage(t.tenantId, '?groupBy=route');
    const row = r.body.data.find((x: { bucket: string }) => x.bucket === '/pending');
    expect(row.requests).toBeGreaterThanOrEqual(3);
  });

  /**
   * The URL carries a uuid; the ROUTE does not. Recording the URL would make
   * this table as large as the traffic and its aggregate useless.
   */
  it('normalises the URL to a route pattern', async () => {
    await request(h.app)
      .get('/api/v1/invoices/00000000-0000-0000-0000-000000000000')
      .set({ authorization: `Bearer ${t.apiKey}` });
    await meterOf().flush();
    const r = await usage(t.tenantId, '?groupBy=route');
    const buckets = r.body.data.map((x: { bucket: string }) => x.bucket);
    expect(buckets).toContain('/invoices/:id');
    for (const b of buckets) expect(b).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it('counts errors separately from requests', async () => {
    await request(h.app)
      .get('/api/v1/invoices/00000000-0000-0000-0000-000000000000')
      .set({ authorization: `Bearer ${t.apiKey}` });
    await meterOf().flush();
    const r = await usage(t.tenantId, '?groupBy=route');
    const row = r.body.data.find((x: { bucket: string }) => x.bucket === '/invoices/:id');
    expect(row.errors).toBeGreaterThan(0);
  });

  it('reports latency percentiles', async () => {
    await request(h.app).get('/api/v1/pending')
      .set({ authorization: `Bearer ${t.apiKey}` });
    await meterOf().flush();
    const r = await usage(t.tenantId, '?groupBy=route');
    const row = r.body.data.find((x: { bucket: string }) => x.bucket === '/pending');
    for (const k of ['p50_ms', 'p95_ms', 'p99_ms']) expect(typeof row[k]).toBe('number');
  });

  it('is RLS-SCOPED — one tenant traffic never appears in another aggregate', async () => {
    for (let i = 0; i < 4; i++) {
      await request(h.app).get('/api/v1/pending')
        .set({ authorization: `Bearer ${other.apiKey}` });
    }
    await meterOf().flush();

    const mine = await withTenant(h.db, t.tenantId, (tx) => tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM api_key_usage'));
    const theirs = await withTenant(h.db, other.tenantId, (tx) => tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM api_key_usage'));
    const both = await withTenant(h.db, t.tenantId, (tx) => tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM api_key_usage WHERE tenant_id = $1`, [other.tenantId]));

    expect(mine.rows[0]!.n).toBeGreaterThan(0);
    expect(theirs.rows[0]!.n).toBeGreaterThan(0);
    // RLS, not a WHERE clause the handler could forget.
    expect(both.rows[0]!.n).toBe(0);
  });

  it('does NOT record unauthenticated traffic — there is no tenant to attribute', async () => {
    const before = await withTenant(h.db, t.tenantId, (tx) => tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM api_key_usage'));
    await request(h.app).get('/api/v1/pending');            // no key
    await request(h.app).get('/health/live');
    await meterOf().flush();
    const after = await withTenant(h.db, t.tenantId, (tx) => tx.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM api_key_usage'));
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('groups by day as well as by route', async () => {
    await request(h.app).get('/api/v1/pending')
      .set({ authorization: `Bearer ${t.apiKey}` });
    await meterOf().flush();
    const r = await usage(t.tenantId);
    expect(r.body.groupBy).toBe('day');
    expect(r.body.data[0].bucket).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('a flush with an empty buffer is a no-op', async () => {
    await meterOf().flush();
    expect(await meterOf().flush()).toBe(0);
  });
});
