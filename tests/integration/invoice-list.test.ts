import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHarness, seedTenant, validInvoice, type Harness } from '../helpers/harness.ts';

/**
 * GET /api/v1/invoices — cursor pagination (API-017).
 *
 * Cursor rather than offset because an offset drifts under concurrent inserts:
 * a client paging its own invoices while submitting more will skip or repeat
 * rows, and a skipped invoice is one that goes unreconciled. The cursor is
 * `(created_at, id)` — a stable total order even when timestamps collide.
 */
let h: Harness;
let t = { apiKey: '', tenantId: '', sellerId: '' };
let other = { apiKey: '', tenantId: '', sellerId: '' };

beforeAll(async () => {
  h = createHarness();
  t = await seedTenant(h);
  other = await seedTenant(h);
  for (let i = 0; i < 7; i++) {
    await request(h.app).post('/api/v1/invoices')
      .set({ authorization: `Bearer ${t.apiKey}` })
      .send({ sellerId: t.sellerId, invoice: validInvoice({ number: `LIST/${i}` }) });
  }
});
afterAll(async () => { await h.close(); });

const list = (qs = '', key = t.apiKey) =>
  request(h.app).get(`/api/v1/invoices${qs}`).set({ authorization: `Bearer ${key}` });

describe('invoice list', () => {
  it('returns this tenant submissions', async () => {
    const r = await list();
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThanOrEqual(7);
  });

  it('is TENANT-SCOPED by RLS — another tenant sees none of these', async () => {
    const mine = new Set((await list()).body.data.map((s: { id: string }) => s.id));
    for (const s of (await list('', other.apiKey)).body.data) {
      expect(mine.has(s.id)).toBe(false);
    }
  });

  it('caps the page size rather than honouring an absurd limit', async () => {
    const r = await list('?limit=99999');
    expect(r.body.data.length).toBeLessThanOrEqual(200);
  });

  /**
   * The property that makes cursors worth the complexity: paging must not skip
   * or repeat, even though rows are being inserted throughout.
   */
  it('pages through EVERY row exactly once, with no repeats', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const r: { body: { data: Array<{ id: string }>; nextCursor: string | null } } =
        await list(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...r.body.data.map((s) => s.id));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);        // no repeats
    expect(seen.length).toBeGreaterThanOrEqual(7);       // nothing skipped
  });

  it('returns a null cursor on the last page', async () => {
    const r = await list('?limit=200');
    expect(r.body.nextCursor).toBeNull();
  });

  it('filters by status', async () => {
    const r = await list('?status=queued');
    for (const s of r.body.data) expect(s.state).toBe('queued');
  });

  it('filters by seller', async () => {
    const r = await list(`?sellerId=${t.sellerId}`);
    expect(r.body.data.length).toBeGreaterThan(0);
    for (const s of r.body.data) expect(s.seller_id).toBe(t.sellerId);
  });

  it('filters by document type', async () => {
    const r = await list('?documentType=TD01');
    for (const s of r.body.data) expect(s.document_type).toBe('TD01');
  });

  it('filters by date range', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await list(`?from=${future}`)).body.data).toHaveLength(0);
  });

  it('rejects a malformed cursor rather than silently ignoring it', async () => {
    const r = await list('?cursor=garbage');
    expect(r.status).toBe(400);
  });

  it('requires the read scope', async () => {
    const k = await request(h.app)
      .post(`/api/v1/admin/tenants/${t.tenantId}/api-keys`)
      .set({ authorization: `Bearer ${(await import('../helpers/harness.ts')).ADMIN_KEY}` })
      .send({ name: 'w', scopes: ['invoices:write'] });
    expect((await list('', k.body.key)).status).toBe(403);
  });
});
