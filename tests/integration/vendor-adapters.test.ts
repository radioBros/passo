import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import { createHarness, seedTenant, ADMIN_KEY, type Harness } from '../helpers/harness.ts';
import { InvoicetronicChannel } from '../../src/infra/channels/invoicetronic.ts';
import { OpenApiChannel, OPENAPI_HOSTS } from '../../src/infra/channels/openapi.ts';
import { ChannelError, type SubmitInput } from '../../src/infra/channels/types.ts';

/**
 * Vendor adapter contracts (SDI-008…SDI-013).
 *
 * Pinned against a local server rather than the real vendors: these assert the
 * REQUEST we send, which is the half that was wrong. Verified 2026-09-02 from
 * published documentation plus unauthenticated probes of the live hosts.
 *
 * The bugs these lock out are not hypothetical — every one was live:
 *   · Invoicetronic sent `Bearer` where the API requires Basic
 *   · Invoicetronic posted to `/send` instead of `/v1/send/file`
 *   · Invoicetronic sent a raw body instead of multipart
 *   · OpenAPI.it used `sdi.openapi.com` — the wrong TLD
 *   · OpenAPI.it read `data.id` where the field is `data.uuid`
 */
interface Captured {
  path: string; method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: Server;
let base = '';
let captured: Captured | null = null;
let respond: { status: number; body: string; type?: string } =
  { status: 200, body: '{}', type: 'application/json' };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      captured = {
        path: req.url ?? '', method: req.method ?? '',
        headers: req.headers, body: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(respond.status, { 'content-type': respond.type ?? 'application/json' });
      res.end(respond.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const input = (over: Partial<SubmitInput> = {}): SubmitInput => ({
  tenantId: '00000000-0000-0000-0000-000000000001',
  submissionId: '00000000-0000-0000-0000-000000000002',
  xml: '<?xml version="1.0"?><p:FatturaElettronica><FormatoTrasmissione>FPR12</FormatoTrasmissione></p:FatturaElettronica>',
  filename: 'IT01234567890_00001.xml',
  signed: false,
  ...over,
});

describe('Invoicetronic adapter', () => {
  const ch = new InvoicetronicChannel();
  const cfg = (over: Record<string, unknown> = {}) =>
    ({ apiKey: 'ik_test_abc123', baseUrl: base, ...over });

  it('posts to /send/file — NOT /invoices, which 404s on the real API', async () => {
    respond = { status: 200, body: JSON.stringify({ id: 225, date_sent: '2026-09-02T10:00:00Z' }) };
    await ch.submit(input(), cfg());
    expect(captured!.path).toBe('/send/file');
    expect(captured!.method).toBe('POST');
  });

  /**
   * The API key is the Basic USERNAME with an EMPTY password, so the encoded
   * pair ends in a colon. Bearer is rejected outright.
   */
  it('authenticates with HTTP Basic, key as username and empty password', async () => {
    respond = { status: 200, body: JSON.stringify({ id: 1 }) };
    await ch.submit(input(), cfg());
    const auth = String(captured!.headers['authorization']);
    expect(auth.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(auth.slice(6), 'base64').toString()).toBe('ik_test_abc123:');
    expect(auth).not.toMatch(/^Bearer/);
  });

  it('sends MULTIPART with the field named `file`, carrying the filename', async () => {
    respond = { status: 200, body: JSON.stringify({ id: 1 }) };
    await ch.submit(input(), cfg());
    expect(String(captured!.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    expect(captured!.body).toMatch(/name="file"/);
    // SdI derives the transmission identity from the filename.
    expect(captured!.body).toMatch(/filename="IT01234567890_00001\.xml"/);
    expect(captured!.body).toContain('FatturaElettronica');
  });

  it('requests signing via the QUERY PARAM, not a header', async () => {
    respond = { status: 200, body: JSON.stringify({ id: 1 }) };
    await ch.submit(input(), cfg({ requestSigning: true }));
    expect(captured!.path).toBe('/send/file?signature=Apply');
  });

  it('does NOT ask for signing when the document is already signed', async () => {
    respond = { status: 200, body: JSON.stringify({ id: 1 }) };
    await ch.submit(input({ signed: true }), cfg({ requestSigning: true }));
    expect(captured!.path).toBe('/send/file');
  });

  it('returns the vendor id, which is the handle for GET /v1/update', async () => {
    respond = { status: 200, body: JSON.stringify({ id: 225, date_sent: '2026-09-02T10:00:00Z' }) };
    const r = await ch.submit(input(), cfg());
    expect(r.channelRef).toBe('225');
    expect(r.acceptedAt.toISOString()).toBe('2026-09-02T10:00:00.000Z');
  });

  it('surfaces problem+json detail rather than a bare status', async () => {
    respond = { status: 400, type: 'application/problem+json',
      body: JSON.stringify({ title: 'Bad Request', detail: 'Invalid FormatoTrasmissione' }) };
    await expect(ch.submit(input(), cfg())).rejects.toThrow(/Invalid FormatoTrasmissione/);
  });

  it('classifies auth, rate limit and 5xx correctly', async () => {
    for (const [status, retryable, code] of [
      [401, false, 'ERR_CHANNEL_AUTH'], [429, true, 'ERR_CHANNEL_UNAVAILABLE'],
      [503, true, 'ERR_CHANNEL_UNAVAILABLE'], [400, false, 'ERR_CHANNEL_REJECTED'],
    ] as Array<[number, boolean, string]>) {
      respond = { status, body: '{}' };
      // Retryability decides retry-versus-DLQ; getting it wrong either loses an
      // invoice or retries a refusal forever.
      await expect(ch.submit(input(), cfg())).rejects.toMatchObject({ retryable, code });
    }
  });

  it('recognises a sandbox key by its prefix', () => {
    // A LIVE key in a staging config transmits real invoices to SdI.
    expect(InvoicetronicChannel.isSandboxKey('ik_test_x')).toBe(true);
    expect(InvoicetronicChannel.isSandboxKey('ik_live_x')).toBe(false);
  });

  it('health probes /status, never a submission', async () => {
    respond = { status: 200, body: '{}' };
    const h = await ch.health(cfg());
    expect(captured!.path).toBe('/status');
    expect(captured!.method).toBe('GET');
    expect(h.ok).toBe(true);
  });

  it('reports UNHEALTHY on 401 — the vendor is up but refuses everything', async () => {
    respond = { status: 401, body: '{}' };
    const h = await ch.health(cfg());
    expect(h.ok).toBe(false);
    expect(h.error).toMatch(/credentials/);
  });
});

describe('OpenAPI.it adapter', () => {
  const ch = new OpenApiChannel();
  const cfg = (over: Record<string, unknown> = {}) => ({ token: 'tok', baseUrl: base, ...over });
  const ok = (data: unknown) =>
    ({ status: 200, body: JSON.stringify({ success: true, message: 'ok', error: null, data }) });

  it('defaults to the .it host — .com is the console, not the API', () => {
    expect(OPENAPI_HOSTS.production).toBe('https://sdi.openapi.it');
    expect(OPENAPI_HOSTS.sandbox).toBe('https://test.sdi.openapi.it');
    // The sandbox is a different HOST, not a flag on production.
    expect(OPENAPI_HOSTS.sandbox).not.toBe(OPENAPI_HOSTS.production);
  });

  it('posts to /invoices with XML and a bearer token', async () => {
    respond = ok({ uuid: 'u-1' });
    await ch.submit(input(), cfg());
    expect(captured!.path).toBe('/invoices');
    expect(String(captured!.headers['authorization'])).toBe('Bearer tok');
    expect(String(captured!.headers['content-type'])).toBe('application/xml');
  });

  it('selects the right one of the FOUR submission endpoints', async () => {
    respond = ok({ uuid: 'u' });
    await ch.submit(input(), cfg({ requestSigning: true }));
    expect(captured!.path).toBe('/invoices_signature');

    respond = ok({ uuid: 'u' });
    await ch.submit(input(), cfg({ legalStorage: true }));
    expect(captured!.path).toBe('/invoices_legal_storage');

    respond = ok({ uuid: 'u' });
    await ch.submit(input(), cfg({ requestSigning: true, legalStorage: true }));
    expect(captured!.path).toBe('/invoices_signature_legal_storage');
  });

  it('reads data.uuid — the documented field, not data.id', async () => {
    respond = ok({ uuid: 'abc-123' });
    expect((await ch.submit(input(), cfg())).channelRef).toBe('abc-123');
  });

  /**
   * The live API returns `{"success":false,"message":"Wrong Token","error":125.22}`.
   * Trusting the HTTP status alone would record a REFUSED submission as
   * accepted — an invoice the CRM believes reached SdI and which never did.
   */
  it('treats the ENVELOPE as authoritative, not the HTTP status', async () => {
    respond = { status: 200,
      body: JSON.stringify({ success: false, message: 'Wrong Token', error: 125.22, data: null }) };
    await expect(ch.submit(input(), cfg())).rejects.toThrow(/Wrong Token/);
  });

  it('includes the NUMERIC error code, which can be fractional', async () => {
    respond = { status: 200,
      body: JSON.stringify({ success: false, message: 'Nope', error: 125.22, data: null }) };
    await expect(ch.submit(input(), cfg())).rejects.toThrow(/error 125\.22/);
  });

  it('classifies auth, rate limit and 5xx correctly', async () => {
    for (const [status, retryable, code] of [
      [401, false, 'ERR_CHANNEL_AUTH'], [429, true, 'ERR_CHANNEL_UNAVAILABLE'],
      [502, true, 'ERR_CHANNEL_UNAVAILABLE'],
    ] as Array<[number, boolean, string]>) {
      respond = { status, body: '{}' };
      await expect(ch.submit(input(), cfg())).rejects.toMatchObject({ retryable, code });
    }
  });

  /**
   * Health reads the business registries. It used to read
   * `/invoices_notifications`, which REQUIRES a uuid — so against the real
   * sandbox it reported a valid account as down ("uuid is required").
   */
  it('health reads the business registries and honours the envelope', async () => {
    respond = ok([{ fiscal_id: '19165748583', active: true }]);
    expect((await ch.health(cfg())).ok).toBe(true);
    expect(captured!.path).toBe('/business_registry_configurations');

    respond = ok([]);
    expect((await ch.health(cfg())).ok, 'no registered seller: every submission would fail').toBe(false);

    respond = { status: 200,
      body: JSON.stringify({ success: false, message: 'Wrong Token', error: 125.22 }) };
    const bad = await ch.health(cfg());
    // A 200 with a failed envelope still means the credentials are dead.
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Wrong Token/);
  });

  it('a ChannelError is what the worker branches on', async () => {
    respond = { status: 401, body: '{}' };
    await expect(ch.submit(input(), cfg())).rejects.toBeInstanceOf(ChannelError);
  });
});

/**
 * Environment guards on channel configuration.
 *
 * Both vendors make it easy to point a staging deployment at production —
 * Invoicetronic by key prefix on ONE host, OpenAPI.it by a DIFFERENT host. A
 * test invoice sent that way reaches the tax authority for real and cannot be
 * recalled: the only remedy is a credit note for a document that was never
 * meant to exist.
 */
describe('channel environment guards', () => {
  let h: Harness;
  let tenantId = '';
  const admin = () => ({ authorization: `Bearer ${ADMIN_KEY}` });
  const put = (channel: string, body: object) =>
    request(h.app).put(`/api/v1/admin/tenants/${tenantId}/channels/${channel}`)
      .set(admin()).send(body);

  beforeAll(async () => {
    h = createHarness();
    tenantId = (await seedTenant(h)).tenantId;
  });
  afterAll(async () => { await h.close(); });

  it('REFUSES a live Invoicetronic key outside production', async () => {
    const r = await put('invoicetronic', { apiKey: 'ik_live_real' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/cannot be recalled/);
  });

  it('accepts a sandbox Invoicetronic key', async () => {
    expect((await put('invoicetronic', { apiKey: 'ik_test_ok' })).status).toBe(200);
  });

  it('REFUSES a key with neither prefix — it is not an Invoicetronic key', async () => {
    const r = await put('invoicetronic', { apiKey: 'some-random-token' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/ik_test_/);
  });

  it('REFUSES the .com host — that is the console, not the API', async () => {
    const r = await put('openapi', { token: 't', baseUrl: 'https://sdi.openapi.com' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/\.it/);
  });

  it('REFUSES an implicit production host outside production', async () => {
    // The adapter default is the PRODUCTION host, so silence is dangerous here.
    const r = await put('openapi', { token: 't' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/test\.sdi\.openapi\.it/);
  });

  it('accepts the sandbox host explicitly', async () => {
    expect((await put('openapi', { token: 't', baseUrl: 'https://test.sdi.openapi.it' })).status)
      .toBe(200);
  });
});
