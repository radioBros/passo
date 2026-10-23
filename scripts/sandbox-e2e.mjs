#!/usr/bin/env node
/**
 * End-to-end proof against the OpenAPI.it SANDBOX, through a running PASSO.
 *
 *   CRM ──POST /invoices──▶ PASSO ──worker──▶ OpenAPI.it sandbox
 *                                               │ POST /simulate (SdI receipt)
 *   CRM ◀── GET /invoices/{id} ◀── PASSO poller ◀┘
 *
 * Opt-in and LOCAL ONLY — never run in CI: it needs a real sandbox token and
 * the running stack. It refuses any host but test.sdi.openapi.it, so it cannot
 * transmit a real invoice to the tax authority.
 *
 *   OPENAPI_TOKEN=…  OPENAPI_SELLER_VAT=…  [OPENAPI_SIGNING_SELLER_VAT=…] \
 *   PASSO_ADMIN_KEY=…  node scripts/sandbox-e2e.mjs
 *
 * Each seller VAT must already have a business registry on the sandbox account
 * (POST /business_registry_configurations): apply_signature=false for
 * OPENAPI_SELLER_VAT, apply_signature=true for OPENAPI_SIGNING_SELLER_VAT.
 * The worker must poll fast enough to finish: set VENDOR_POLL_INTERVAL_MS=30000.
 *
 * The token is read from the environment and never printed.
 */
const SANDBOX = 'https://test.sdi.openapi.it';
const env = (k, d) => process.env[k] ?? d ?? (() => { throw new Error(`${k} is required`); })();
const TOKEN = env('OPENAPI_TOKEN');
const ADMIN = env('PASSO_ADMIN_KEY');
const PASSO = env('PASSO_URL', `http://localhost:${process.env.PASSO_PORT ?? 3000}`);
const SELLER_VAT = env('OPENAPI_SELLER_VAT');
const SIGNING_VAT = process.env.OPENAPI_SIGNING_SELLER_VAT;
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 180_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function http(base, path, { method = 'GET', body, auth, accept } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(accept ? { accept } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const passo = (path, o) => http(PASSO, path, o);
const vendor = (path, o) => http(SANDBOX, path, { ...o, auth: TOKEN });

const invoice = (vat, format, number) => ({
  documentType: 'TD01', number, date: new Date().toISOString().slice(0, 10), currency: 'EUR', format,
  recipientCode: format === 'FPA12' ? 'UFY9MH' : '0000000',
  ...(format === 'FPR12' ? { recipientPec: 'cliente@pec.example.it' } : {}),
  seller: {
    vatId: { country: 'IT', code: vat }, name: `PASSO E2E ${vat}`, taxRegime: 'RF01',
    address: { street: 'Via Roma 1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
  },
  buyer: {
    vatId: { country: 'IT', code: '12345678903' }, name: 'Cliente Sandbox S.p.A.',
    address: { street: 'Via Milano 2', postalCode: '00100', city: 'Roma', province: 'RM', country: 'IT' },
  },
  lines: [{ lineNumber: 1, description: 'Servizi di consulenza', unitPrice: '1000.00', totalPrice: '1000.00', vatRate: '22.00' }],
  summaries: [{ vatRate: '22.00', taxableAmount: '1000.00', taxAmount: '220.00' }],
});

async function setupTenant(vat, requestSigning) {
  const slug = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const t = await passo('/api/v1/admin/tenants', { method: 'POST', auth: ADMIN,
    body: { name: `E2E ${slug}`, slug, transmitterCode: vat } });
  if (t.status !== 201) throw new Error(`create tenant: ${t.status} ${JSON.stringify(t.body)}`);
  const tenant = t.body.id;
  const s = await passo(`/api/v1/admin/tenants/${tenant}/sellers`, { method: 'POST', auth: ADMIN,
    body: { taxRegime: 'RF01', denomination: `PASSO E2E ${vat}`, vatCountry: 'IT', vatCode: vat,
            address: { street: 'Via Roma 1', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' } } });
  if (s.status !== 201) throw new Error(`create seller: ${s.status} ${JSON.stringify(s.body)}`);
  const c = await passo(`/api/v1/admin/tenants/${tenant}/channels/openapi`, { method: 'PUT', auth: ADMIN,
    body: { token: TOKEN, baseUrl: SANDBOX, requestSigning } });
  if (c.status >= 300) throw new Error(`configure channel: ${c.status} ${JSON.stringify(c.body)}`);
  const k = await passo(`/api/v1/admin/tenants/${tenant}/api-keys`, { method: 'POST', auth: ADMIN,
    body: { name: 'e2e', environment: 'test', scopes: ['invoices:read', 'invoices:write', 'webhooks:read', 'webhooks:write'] } });
  if (k.status !== 201) throw new Error(`create api key: ${k.status} ${JSON.stringify(k.body)}`);
  // Optional: a CRM webhook, to prove receipt events are actually dispatched.
  let webhook = null;
  if (process.env.E2E_WEBHOOK_URL) {
    const w = await passo('/api/v1/webhooks', { method: 'POST', auth: k.body.key,
      body: { url: process.env.E2E_WEBHOOK_URL } });
    if (w.status !== 201) throw new Error(`create webhook: ${w.status} ${JSON.stringify(w.body)}`);
    webhook = w.body.id;
  }
  return { tenant, seller: s.body.id, key: k.body.key, webhook };
}

async function waitFor(what, fn) {
  const until = Date.now() + TIMEOUT_MS;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(3000);
  }
}

/** One scenario: submit → transmitted → simulate a receipt → PASSO reaches `expect`. */
async function scenario(name, { vat, format, requestSigning, notification, expect }) {
  log(`── ${name}`);
  const t = await setupTenant(vat, requestSigning);
  const number = `E2E-${Date.now().toString(36)}`;  // unique per run
  const sub = await passo('/api/v1/invoices', { method: 'POST', auth: t.key,
    body: { sellerId: t.seller, invoice: invoice(vat, format, number) } });
  if (sub.status !== 202) throw new Error(`submit: ${sub.status} ${JSON.stringify(sub.body)}`);
  const id = sub.body.submissionId;
  log(`   accepted by PASSO   ${id}  (${sub.body.filename})`);

  // PASSO reports the vendor's reference itself — no (billed) vendor lookup needed.
  const sent = await waitFor('transmitted', async () => {
    const s = await passo(`/api/v1/invoices/${id}`, { auth: t.key });
    if (s.body.status === 'failed') throw new Error(`PASSO marked it failed: ${JSON.stringify(s.body)}`);
    return s.body.status === 'transmitted' && s.body.channelRef ? s.body : null;
  });
  const listed = { uuid: sent.channelRef };
  log(`   transmitted         vendor uuid ${listed.uuid}`);

  const sim = await vendor('/simulate/customer-notification', { method: 'POST',
    body: { uuid: listed.uuid, notification } });
  if (sim.body?.success !== true) throw new Error(`simulate: ${JSON.stringify(sim.body)}`);
  log(`   SdI ${notification} simulated`);

  const done = await waitFor(`status ${expect}`, async () => {
    const s = await passo(`/api/v1/invoices/${id}`, { auth: t.key });
    return s.body.status === expect ? s.body : null;
  });
  log(`   ✅ PASSO status: ${done.status}`);
  if (t.webhook) {
    // The endpoint may refuse the POST; what matters is that PASSO ATTEMPTED it.
    const d = await waitFor('webhook delivery attempt', async () => {
      const r = await passo(`/api/v1/webhooks/${t.webhook}/deliveries`, { auth: t.key });
      const rows = r.body?.deliveries ?? r.body?.data ?? (Array.isArray(r.body) ? r.body : []);
      return rows.length ? rows : null;
    });
    log(`   ✅ CRM webhook dispatched: ${d.length} attempt(s), event ${d[0].event_type ?? d[0].eventType}, HTTP ${d[0].status_code ?? d[0].statusCode}`);
  }
  return { name, id, vendorUuid: listed.uuid, status: done.status, body: done };
}

const health = await passo('/health/ready');
if (health.status !== 200) throw new Error(`PASSO not ready at ${PASSO}: ${health.status}`);

const results = [];
const run = async (name, o) => {
  try { results.push(await scenario(name, o)); }
  catch (e) { results.push({ name, error: e.message }); log(`   ❌ ${e.message}`); }
};
await run('B2B delivered (RC)', { vat: SELLER_VAT, format: 'FPR12', requestSigning: false,
  notification: 'RC', expect: 'delivered' });
await run('B2B rejected (NS)', { vat: SELLER_VAT, format: 'FPR12', requestSigning: false,
  notification: 'NS', expect: 'rejected' });
if (SIGNING_VAT) {
  await run('B2G signed by vendor, delivered (RC)', { vat: SIGNING_VAT, format: 'FPA12',
    requestSigning: true, notification: 'RC', expect: 'delivered' });
}

console.log('\n' + JSON.stringify(results.map(({ body, ...r }) =>
  ({ ...r, ...(body?.notifications ? { notifications: body.notifications.map((n) => n.type ?? n) } : {}) })), null, 2));
process.exit(results.some((r) => r.error) ? 1 : 0);
