import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { createHarness, seedTenant, validInvoice, ADMIN_KEY, type Harness } from '../helpers/harness.ts';
import { withTenant } from '../../src/infra/db/pool.ts';
import { submitInvoice } from '../../src/domain/submission/service.ts';
import { OpenApiChannel } from '../../src/infra/channels/openapi.ts';
import { startVendorPoller } from '../../src/workers/vendor-poller.ts';
import { vendorInvoiceRef } from '../../src/api/routes/inbound.ts';
import { STATE } from '../../src/domain/submission/state.ts';
import { logger } from '../../src/shared/logger.ts';

/**
 * OpenAPI.it receipts — found broken by the first real sandbox round trip.
 *
 * PASSO routed receipts only by IdentificativoSdI or PEC Message-ID, and kept
 * neither for an OpenAPI.it submission, so EVERY receipt was quarantined and
 * the invoice stayed `transmitted` forever. The vendor is stubbed here with
 * the exact responses the sandbox returned on 2026-10-01 — including the
 * placeholder IdentificativoSdI "111" that every simulated receipt carries.
 */
let h: Harness;
let t = { tenantId: '', sellerId: '', apiKey: '' };
let inboundUrl = '';
const RC = readFileSync('tests/fixtures/openapi/notifications-rc.xml', 'utf8');
const EMPTY = readFileSync('tests/fixtures/openapi/notifications-empty.xml', 'utf8');

/** A stub of the vendor: per-uuid receipts XML and sdi_file_id. */
const vendor = new Map<string, { xml: string; sdiFileId: string }>();
const fetched: string[] = [];
const stubVendor = () => vi.stubGlobal('fetch', vi.fn(async (u: string, init?: { headers?: Record<string, string> }) => {
  const url = String(u);
  fetched.push(url);
  const uuid = decodeURIComponent(url.split('/').pop()!);
  const v = vendor.get(uuid);
  if (url.includes('/invoices_notifications/')) {
    const body = v?.xml ?? EMPTY;
    if (init?.headers?.['Accept'] === 'application/xml') {
      return { ok: true, status: 200, text: async () => body, json: async () => ({}) } as never;
    }
    // The free JSON-LD listing: one member per <item> in the XML.
    const n = (body.match(/<item /g) ?? []).length;
    return new Response(JSON.stringify({ 'hydra:totalItems': n, 'hydra:member': Array.from({ length: n }, () => ({})) }),
      { status: 200, headers: { 'content-type': 'application/ld+json' } });
  }
  return new Response(JSON.stringify({ success: true, data: { sdi_file_id: v?.sdiFileId ?? null } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
}));

beforeAll(async () => {
  h = createHarness();
  t = await seedTenant(h);
  const r = await request(h.app)
    .put(`/api/v1/admin/tenants/${t.tenantId}/channels/openapi`)
    .set({ authorization: `Bearer ${ADMIN_KEY}` })
    .send({ token: 'sandbox-token', baseUrl: 'https://test.sdi.openapi.it' });
  expect(r.status).toBeLessThan(300);
  inboundUrl = new URL(r.body.inboundWebhookUrl).pathname;
});
afterEach(() => { vi.unstubAllGlobals(); fetched.length = 0; });
afterAll(async () => { await h.close(); });

/** An OpenAPI.it submission as the submit worker leaves it: transmitted, with the vendor uuid. */
const transmitted = async (uuid: string, sdiFileId: string, xml = RC): Promise<string> => {
  const s = await submitInvoice(h.db, h.keys, validInvoice(), {
    tenantId: t.tenantId, sellerId: t.sellerId, channel: new OpenApiChannel(),
    channelConfig: { token: 'sandbox-token' },
  });
  await withTenant(h.db, t.tenantId, (tx) => tx.query(
    `UPDATE sdi_submissions SET state = $2, submitted_at = now(), channel_ref = $3 WHERE id = $1`,
    [s.submissionId, STATE.transmitted, uuid]));
  vendor.set(uuid, { xml, sdiFileId });
  return s.submissionId;
};

const row = async (id: string) => (await withTenant(h.db, t.tenantId, (tx) => tx.query<{
  state: string; identificativo_sdi: string | null; n: number;
}>(
  `SELECT s.state, s.identificativo_sdi,
          (SELECT count(*)::int FROM notifications WHERE submission_id = s.id) AS n
     FROM sdi_submissions s WHERE s.id = $1`, [id]))).rows[0]!;

const uid = () => `01a0f93a-${Math.random().toString(16).slice(2, 6)}-78bf-9b9b-${Date.now().toString(16).padStart(12, '0')}`;

describe('OpenAPI.it receipt polling', () => {
  it('applies a receipt fetched by the vendor uuid, with the REAL IdentificativoSdI', async () => {
    stubVendor();
    const id = await transmitted(uid(), '17942054486');
    const poller = startVendorPoller(h.db, h.keys, logger, 3_600_000);
    try { await poller.tick(); } finally { poller.stop(); }

    const r = await row(id);
    expect(r.state).toBe(STATE.delivered);
    expect(r.identificativo_sdi, 'sdi_file_id, not the "111" placeholder in the receipt').toBe('17942054486');
    expect(r.n).toBe(1);
  });

  it('re-reading on the next tick changes nothing — ingestion is idempotent', async () => {
    stubVendor();
    const id = await transmitted(uid(), '555000111');
    const poller = startVendorPoller(h.db, h.keys, logger, 3_600_000);
    try { await poller.tick(); await poller.tick(); } finally { poller.stop(); }
    expect((await row(id)).n).toBe(1);
  });

  /** Every sandbox receipt carries the same placeholder ids; two invoices must not collide. */
  it('two invoices with IDENTICAL placeholder receipts are both applied', async () => {
    stubVendor();
    const a = await transmitted(uid(), '900000001');
    const b = await transmitted(uid(), '900000002');
    const poller = startVendorPoller(h.db, h.keys, logger, 3_600_000);
    try { await poller.tick(); } finally { poller.stop(); }
    expect((await row(a)).state).toBe(STATE.delivered);
    expect((await row(b)).state).toBe(STATE.delivered);
  });

  it('does not poll an invoice that has already reached a terminal state', async () => {
    stubVendor();
    const ref = uid();
    const id = await transmitted(ref, '900000003');
    await withTenant(h.db, t.tenantId, (tx) => tx.query(
      'UPDATE sdi_submissions SET state = $2 WHERE id = $1', [id, STATE.rejected]));
    const poller = startVendorPoller(h.db, h.keys, logger, 3_600_000);
    try { await poller.tick(); } finally { poller.stop(); }
    expect(fetched.some((u) => u.includes(ref))).toBe(false);
  });
});

describe('OpenAPI.it webhook', () => {
  const post = (body: unknown) => request(h.app).post(inboundUrl)
    .set('content-type', 'application/json').send(JSON.stringify(body));

  it('a callback is VERIFIED by re-reading the vendor, then applied', async () => {
    stubVendor();
    const ref = uid();
    const id = await transmitted(ref, '900000010');
    const r = await post({ uuid: 'n-1', invoice_uuid: ref, type: 'RC' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: true, status: 'verified', applied: 1 });
    expect((await row(id)).state).toBe(STATE.delivered);
  });

  /**
   * The body is a HINT. A forged callback claiming an NS — which is terminal
   * and would make the CRM reissue a valid invoice — changes nothing the
   * vendor does not itself report.
   */
  it('a FORGED callback body cannot set the state — the vendor\'s receipt wins', async () => {
    stubVendor();
    const ref = uid();
    const id = await transmitted(ref, '900000011', EMPTY);   // vendor: no receipts yet
    const forged = { invoice_uuid: ref, type: 'NS',
      message: { lista_errori: { Errore: { Codice: '00404', Descrizione: 'forged' } } } };
    const r = await post(forged);
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(0);
    expect((await row(id)).state, 'still transmitted, NOT rejected').toBe(STATE.transmitted);
  });

  it('an unknown invoice reference is acknowledged (200) but applies nothing', async () => {
    stubVendor();
    const r = await post({ invoice_uuid: uid() });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('unknown_reference');
  });

  it('a callback with no invoice reference is refused', async () => {
    stubVendor();
    expect((await post({ hello: 'world' })).status).toBe(400);
  });
});

describe('vendorInvoiceRef', () => {
  it('finds invoice_uuid however deeply the callback nests it', () => {
    expect(vendorInvoiceRef(JSON.stringify({ data: { notification: { invoice_uuid: '01a0f93a-b70f-78bf-9b9b-9ab0693a69d2' } } })))
      .toBe('01a0f93a-b70f-78bf-9b9b-9ab0693a69d2');
  });
  it('falls back to an invoice event uuid', () => {
    expect(vendorInvoiceRef(JSON.stringify({ data: { uuid: '01a0f93a-b70f-78bf-9b9b-9ab0693a69d2' } })))
      .toBe('01a0f93a-b70f-78bf-9b9b-9ab0693a69d2');
  });
  it('returns null for non-JSON and for values that are not identifiers', () => {
    expect(vendorInvoiceRef('<xml/>')).toBeNull();
    expect(vendorInvoiceRef(JSON.stringify({ invoice_uuid: "'; DROP TABLE x; --" }))).toBeNull();
  });
});
