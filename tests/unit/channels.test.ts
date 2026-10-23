import { readFileSync } from 'node:fs';
import { ERRORS } from '../../src/shared/errors/catalog.ts';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InvoicetronicChannel } from '../../src/infra/channels/invoicetronic.ts';
import { OpenApiChannel } from '../../src/infra/channels/openapi.ts';
import { ChannelError } from '../../src/infra/channels/types.ts';
import { MockChannel } from '../../src/infra/channels/mock.ts';

const input = {
  tenantId: 't', submissionId: 's',
  xml: '<?xml version="1.0"?><x/>', filename: 'IT01234567890_00001.xml', signed: false,
};
const res = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); });

describe('Invoicetronic adapter', () => {
  const ch = new InvoicetronicChannel();

  it('advertises server-side signing (verified in vendor docs)', () => {
    expect(ch.capabilities.serverSideSigning).toBe(true);
    expect(ch.capabilities.pushNotifications).toBe(true);
  });

  it('rejects a missing API key without a network call', async () => {
    let called = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { called++; return res(200); }));
    await expect(ch.submit(input, {})).rejects.toThrow(ChannelError);
    expect(called).toBe(0);
  });

  /**
   * The send response is the DOCUMENT, keyed by `id`. The IdentificativoSdI
   * arrives later with the receipt, not here — an earlier revision expected it
   * on the send response and would have recorded `undefined`.
   */
  it('returns the vendor id on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { id: 225, date_sent: '2026-09-02T10:00:00Z' })));
    const r = await ch.submit(input, { apiKey: 'ik_test_k' });
    expect(r.channelRef).toBe('225');
    expect(r.identificativoSdI).toBeUndefined();
  });

  it('401 is NOT retryable — an operator must fix the credential', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(401)));
    await expect(ch.submit(input, { apiKey: 'bad' })).rejects.toMatchObject({ retryable: false });
  });

  it('5xx IS retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(503)));
    await expect(ch.submit(input, { apiKey: 'k' })).rejects.toMatchObject({ retryable: true });
  });

  it('4xx is NOT retryable — resubmitting a bad payload would duplicate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad request', { status: 400 })));
    await expect(ch.submit(input, { apiKey: 'k' })).rejects.toMatchObject({ retryable: false });
  });

  it('a network failure IS retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(ch.submit(input, { apiKey: 'k' })).rejects.toMatchObject({ retryable: true });
  });

  /**
   * Signing is a QUERY PARAMETER on the real API, not a header. The earlier
   * `X-Sign: true` header was ignored, so `requestSigning` silently did
   * nothing — and a B2G invoice would have reached SdI unsigned.
   */
  it('requests signing via the query parameter, only when unsigned', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { urls.push(u); return res(200, { id: 1 }); }));

    await ch.submit(input, { apiKey: 'ik_test_k', requestSigning: true });
    expect(urls[0]).toMatch(/\/send\/file\?signature=Apply$/);

    urls.length = 0;
    await ch.submit({ ...input, signed: true }, { apiKey: 'ik_test_k', requestSigning: true });
    expect(urls[0]).toMatch(/\/send\/file$/);
  });
});

/**
 * OpenAPI.it — every expectation below was OBSERVED against the live sandbox
 * on 2026-10-01, not inferred from documentation. An earlier version of these
 * tests asserted a `data.id` and an `identificativo_sdi` in the submit
 * response; the real response carries only `data.uuid`.
 */
describe('OpenAPI.it adapter', () => {
  const ch = new OpenApiChannel();
  const RC = readFileSync('tests/fixtures/openapi/notifications-rc.xml', 'utf8');
  const EMPTY = readFileSync('tests/fixtures/openapi/notifications-empty.xml', 'utf8');
  const text = (status: number, body: string) =>
    ({ ok: status < 400, status, json: async () => JSON.parse(body), text: async () => body }) as never;

  it('rejects a missing token', async () => {
    await expect(ch.submit(input, {})).rejects.toThrow(ChannelError);
  });

  it('routes to /invoices_signature when signing is requested', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { urls.push(String(u)); return res(200, { success: true, data: { uuid: 'u-1' } }); }));
    await ch.submit(input, { token: 't', requestSigning: true });
    expect(urls[0]).toContain('/invoices_signature');
  });

  it('routes to /invoices when the document is already signed', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { urls.push(String(u)); return res(200, { success: true, data: { uuid: 'u-1' } }); }));
    await ch.submit({ ...input, signed: true }, { token: 't', requestSigning: true });
    expect(urls[0]).toMatch(/\/invoices$/);
  });

  it('returns the vendor uuid as channelRef — the key every receipt is fetched by', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200,
      { data: { uuid: '01a0f93a-b70f-78bf-9b9b-9ab0693a69d2' }, message: '', success: true, error: null })));
    const r = await ch.submit(input, { token: 't' });
    expect(r.channelRef).toBe('01a0f93a-b70f-78bf-9b9b-9ab0693a69d2');
  });

  it('a success without a uuid is a failure — it could never be tracked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { success: true, data: {} })));
    await expect(ch.submit(input, { token: 't' })).rejects.toThrow(/no uuid/);
  });

  /** Observed: the missing-registry error arrives as HTTP 401. */
  it('a missing business registry is a SETUP error, not a credential error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(401,
      { success: false, message: 'No business registry configurations have been set up.', error: 661 })));
    await expect(ch.submit(input, { token: 't' })).rejects.toMatchObject(
      { code: 'ERR_CHANNEL_SETUP', retryable: false, message: expect.stringMatching(/business registry/) });
  });

  it('a signing setting that disagrees with the registry names the fix', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(400, { success: false,
      message: 'Your current configuration for this fiscal_id does not allow requests on this endpoint. Please use: /invoices',
      error: 387 })));
    await expect(ch.submit(input, { token: 't', requestSigning: true })).rejects.toMatchObject(
      { code: 'ERR_CHANNEL_SETUP', message: expect.stringMatching(/requestSigning.*apply_signature/) });
  });

  it('a wrong token (error 125.22) is a credential error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(401, { success: false, message: 'Wrong Token', error: 125.22 })));
    await expect(ch.submit(input, { token: 't' })).rejects.toMatchObject({ code: 'ERR_CHANNEL_AUTH' });
  });

  it('vendor error 304 ("Not enought credit in wallet", seen on submit) is the credit error too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(402, { success: false, message: 'Not enought credit in wallet', error: 304 })));
    await expect(ch.submit(input, { token: 't' })).rejects.toMatchObject(
      { code: 'ERR_CHANNEL_CREDIT', retryable: true, delivery: 'not_sent' });
  });

  it('402 is RETRIED — failing would lose every invoice queued while out of credit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(402)));
    await expect(ch.submit(input, { token: 't' })).rejects.toMatchObject({ retryable: true });
  });

  it('success:false with a 200 is a refusal, not an acceptance', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { success: false, message: 'nope', error: 1 })));
    await expect(ch.submit(input, { token: 't' })).rejects.toMatchObject({ code: 'ERR_CHANNEL_REJECTED' });
  });

  it('403 is NOT retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(403)));
    await expect(ch.submit(input, { token: 't' })).rejects.toMatchObject({ retryable: false });
  });

  /** A vendor stub that answers the way the sandbox does, by URL and Accept header. */
  const vendorStub = (o: { listed: number; xml: string; inv?: unknown; calls?: string[] }) =>
    vi.fn(async (u: string, init: { headers: Record<string, string> }) => {
      const accept = init.headers['Accept'] ?? '';
      o.calls?.push(`${String(u).includes('notifications') ? 'notifications' : 'invoice'}:${accept || 'ld'}`);
      if (String(u).includes('/invoices_notifications/')) {
        return accept === 'application/xml'
          ? text(200, o.xml)
          : res(200, { 'hydra:totalItems': o.listed, 'hydra:member': Array.from({ length: o.listed }, () => ({})) });
      }
      return res(200, o.inv ?? { success: true, data: {} });
    });

  it('fetches receipts as genuine SdI XML and takes IdentificativoSdI from the INVOICE record', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vendorStub({ listed: 1, xml: RC, calls,
      inv: { success: true, data: { sdi_file_id: '17942054486', sdi_file_name: 'IT10442360961ACB26_00C9u.xml' } } }));
    const r = await ch.fetchReceipts({ token: 't' }, '01a0f93a-b70f-78bf-9b9b-9ab0693a69d2');
    expect(calls).toEqual(['notifications:application/xml', 'invoice:application/json']);
    expect(r.identificativoSdI, 'the real id, not the placeholder in the receipt').toBe('17942054486');
    expect(r.sdiFileName).toBe('IT10442360961ACB26_00C9u.xml');
    expect(r.notifications).toHaveLength(1);
    expect(r.notifications[0]!.type).toBe('RC');
    expect(r.poison).toHaveLength(0);
  });

  /** The common poll: nothing yet. One call to the XML listing (free), nothing billed. */
  it('an invoice with no receipts yet costs one free call and nothing billed', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vendorStub({ listed: 0, xml: EMPTY, calls }));
    const r = await ch.fetchReceipts({ token: 't' }, 'u');
    expect(calls).toEqual(['notifications:application/xml']);
    expect(r.notifications).toHaveLength(0);
  });

  /**
   * Observed 2026-10-02: the JSON-LD listing lagged the XML (1 receipt vs 2).
   * The XML is read regardless of what the listing says.
   */
  it('reads the XML even when the JSON-LD listing says there is nothing', async () => {
    vi.stubGlobal('fetch', vendorStub({ listed: 0, xml: RC }));
    const r = await ch.fetchReceipts({ token: 't' }, 'u', { withIds: false });
    expect(r.notifications.map((n) => n.type)).toEqual(['RC']);
  });

  it('skips the BILLED invoice record when the id is already known', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vendorStub({ listed: 1, xml: RC, calls }));
    await ch.fetchReceipts({ token: 't' }, 'u', { withIds: false });
    expect(calls).not.toContain('invoice:application/json');
  });

  it('a failed id lookup (e.g. out of credit) never blocks applying the receipt', async () => {
    vi.stubGlobal('fetch', vendorStub({ listed: 1, xml: RC,
      inv: { success: false, message: 'Insufficient Credit in Wallet', error: '611' } }));
    const r = await ch.fetchReceipts({ token: 't' }, 'u');
    expect(r.notifications).toHaveLength(1);
    expect(r.identificativoSdI).toBeUndefined();
  });

  /**
   * Observed 2026-10-02: for a few minutes an XML request was answered with
   * JSON-LD. That is a retryable condition — as poison it would quarantine a
   * healthy response on every poll.
   */
  it('JSON where XML was asked for is RETRYABLE, never poison', async () => {
    const ld = JSON.stringify({ '@type': 'hydra:Collection', 'hydra:totalItems': 1, 'hydra:member': [{}] });
    vi.stubGlobal('fetch', vendorStub({ listed: 1, xml: ld }));
    await expect(ch.fetchReceipts({ token: 't' }, 'u')).rejects.toMatchObject(
      { retryable: true, message: expect.stringMatching(/JSON instead of XML/) });
  });

  it('an unparseable receipt is returned as POISON, never dropped', async () => {
    const bad = '<response><item key="k1"><![CDATA[<NotAReceipt/>]]></item></response>';
    vi.stubGlobal('fetch', vendorStub({ listed: 1, xml: bad }));
    const r = await ch.fetchReceipts({ token: 't' }, 'u');
    expect(r.notifications).toHaveLength(0);
    expect(r.poison).toHaveLength(1);
    expect(r.poison[0]!.raw).toBe('<NotAReceipt/>');
  });

  it('health reads the business registries — a valid account is healthy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { success: true, data: [{ fiscal_id: '1', active: true }] })));
    expect((await ch.health({ token: 't' })).ok).toBe(true);
  });

  it('health is NOT ok when no seller is registered — every submission would fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { success: true, data: [] })));
    const h = await ch.health({ token: 't' });
    expect(h.ok).toBe(false);
    expect(h.error).toMatch(/business registry/);
  });
});

describe('Mock channel', () => {
  it('emits the configured notification sequence', async () => {
    const ch = new MockChannel({ sequence: ['RC'] });
    const r = await ch.submit(input);
    expect(r.identificativoSdI).toBeTruthy();
    const n = (await ch.poll()).notifications;
    expect(n).toHaveLength(1);
    expect(n[0]!.type).toBe('RC');
  });

  it('stamps each submission with a distinct IdentificativoSdI', async () => {
    const ch = new MockChannel({ sequence: ['RC'] });
    const a = await ch.submit(input);
    await ch.poll();
    const b = await ch.submit(input);
    expect(b.identificativoSdI).not.toBe(a.identificativoSdI);
  });

  it('can emit an NS for rejection testing', async () => {
    const ch = new MockChannel({ sequence: ['NS'] });
    await ch.submit(input);
    const n = (await ch.poll()).notifications;
    expect(n[0]!.type).toBe('NS');
    expect(n[0]!.errors.length).toBeGreaterThan(0);
  });

  it('drains its queue — a second poll returns nothing', async () => {
    const ch = new MockChannel({ sequence: ['RC'] });
    await ch.submit(input);
    expect((await ch.poll()).notifications).toHaveLength(1);
    expect((await ch.poll()).notifications).toHaveLength(0);
  });
});

/**
 * SDI-019 — every vendor error maps to a catalogued code.
 *
 * A `ChannelError` carrying a code that is not in the catalogue never becomes
 * an HTTP response: the error middleware falls through to a bare 500, and a
 * CRM is told to retry something that will fail identically forever.
 */
describe('vendor error mapping', () => {
  const CODES = new Set(Object.keys(ERRORS));

  it('every code any adapter throws exists in the catalogue', async () => {
    const files = ['invoicetronic.ts', 'openapi.ts', 'pec.ts', 'mock.ts'];
    const { readFileSync } = await import('node:fs');
    const used = new Set<string>();
    for (const f of files) {
      const src = readFileSync(`src/infra/channels/${f}`, 'utf8');
      for (const m of src.matchAll(/'(ERR_[A-Z_]+)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const code of used) {
      expect(CODES.has(code), `${code} is thrown by an adapter but absent from the catalogue`)
        .toBe(true);
    }
  });

  it('classifies transport faults as RETRYABLE and refusals as terminal', () => {
    // Retrying a refusal wastes attempts and delays the real fix; not retrying
    // a transport fault loses an invoice to a blip.
    expect(ERRORS.ERR_CHANNEL_UNAVAILABLE.retryable).toBe(true);
    expect(ERRORS.ERR_CHANNEL_TIMEOUT.retryable).toBe(true);
    expect(ERRORS.ERR_CHANNEL_AUTH.retryable).toBe(false);
    expect(ERRORS.ERR_CHANNEL_REJECTED.retryable).toBe(false);
  });

  it('a ChannelError carries its retryability to the worker', () => {
    const transient = new ChannelError('vendor 503', true, 'ERR_CHANNEL_UNAVAILABLE');
    const terminal = new ChannelError('vendor 400', false, 'ERR_CHANNEL_REJECTED');
    // The worker branches on exactly this to choose retry versus DLQ.
    expect(transient.retryable).toBe(true);
    expect(terminal.retryable).toBe(false);
  });
});
