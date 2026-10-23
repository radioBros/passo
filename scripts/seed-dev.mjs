#!/usr/bin/env node
/**
 * Seed a working development tenant (DEP-011).
 *
 * A new developer should reach a submitted invoice without reading the API
 * reference first. This creates a tenant, an API key, a seller, the mock
 * channel and a sample transformation, then prints what to export.
 *
 *   node scripts/seed-dev.mjs
 */
const BASE = process.env.PASSO_URL ?? `http://localhost:${process.env.PASSO_PORT ?? 3000}`;
const ADMIN = process.env.PASSO_ADMIN_KEY;
if (!ADMIN) { console.error('PASSO_ADMIN_KEY is required'); process.exit(1); }

const api = async (method, path, body) => {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  return r.json();
};

const slug = `dev-${Math.random().toString(36).slice(2, 7)}`;
const tenant = await api('POST', '/admin/tenants',
  { name: 'Development', slug, transmitterCode: '01234567890' });
const key = await api('POST', `/admin/tenants/${tenant.id}/api-keys`, { name: 'dev' });
const seller = await api('POST', `/admin/tenants/${tenant.id}/sellers`, {
  taxRegime: 'RF01', denomination: 'Fornitore S.r.l.',
  vatCountry: 'IT', vatCode: '01234567890',
  address: { street: 'Via Roma 1', postalCode: '20100', city: 'Milano',
             province: 'MI', country: 'IT' },
});
// Mock: reaches SdI never, which is the point in development.
await api('PUT', `/admin/tenants/${tenant.id}/channels/mock`, {});

console.log(`
Seeded.

  export PASSO_TENANT=${tenant.id}
  export PASSO_KEY=${key.key}
  export PASSO_SELLER=${seller.id}

Submit one:

  curl -X POST ${BASE}/api/v1/invoices \\
    -H "authorization: Bearer $PASSO_KEY" -H 'content-type: application/json' \\
    -d '{"sellerId":"'$PASSO_SELLER'","invoice":{
         "documentType":"TD01","number":"DEV/1","date":"2026-09-02","currency":"EUR",
         "format":"FPR12","recipientCode":"ABC1234",
         "seller":{"vatId":{"country":"IT","code":"01234567890"},"name":"Fornitore S.r.l.",
                   "taxRegime":"RF01","address":{"street":"Via Roma","postalCode":"20100",
                   "city":"Milano","province":"MI","country":"IT"}},
         "buyer":{"vatId":{"country":"IT","code":"09876543210"},"name":"Cliente S.p.A.",
                  "address":{"street":"Via Milano","postalCode":"00100","city":"Roma",
                  "province":"RM","country":"IT"}},
         "lines":[{"lineNumber":1,"description":"Consulenza","unitPrice":"100.00",
                   "totalPrice":"100.00","vatRate":"22.00"}],
         "summaries":[{"vatRate":"22.00","taxableAmount":"100.00","taxAmount":"22.00"}]}}'
`);
