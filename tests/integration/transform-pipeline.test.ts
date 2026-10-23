import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHarness, seedTenant, ADMIN_KEY, type Harness } from '../helpers/harness.ts';

/**
 * XFORM invocation — templates applied to a REAL submission.
 *
 * Templates were validated and stored for a long time without anything ever
 * calling them: the feature read as working from both the plan and the API
 * while a submitted invoice was never actually transformed. These tests exist
 * so that gap cannot reopen silently — each one fails if the wiring is removed.
 */
let h: Harness;
let tenantId = '';
let sellerId = '';
let key = '';

beforeAll(async () => {
  h = createHarness();
  const t = await seedTenant(h);
  tenantId = t.tenantId; sellerId = t.sellerId; key = t.apiKey;
});
afterAll(async () => { await h.close(); });

const admin = () => ({ authorization: `Bearer ${ADMIN_KEY}` });
const auth = () => ({ authorization: `Bearer ${key}` });

/** A template mapping one CRM's field names onto the canonical model. */
const template = (name = 'acme') => ({
  name, sourceFormat: 'acme/v1',
  rules: [
    { target: 'documentType', literal: 'TD01' },
    { target: 'number', source: 'doc_no', required: true },
    { target: 'date', source: 'doc_date', required: true },
    { target: 'currency', literal: 'EUR' },
    { target: 'format', literal: 'FPR12' },
    { target: 'recipientCode', source: 'customer.sdi_code' },
    { target: 'seller.vatId.country', literal: 'IT' },
    { target: 'seller.vatId.code', source: 'vendor.vat' },
    { target: 'seller.name', source: 'vendor.name' },
    { target: 'seller.taxRegime', literal: 'RF01' },
    { target: 'seller.address.street', source: 'vendor.addr.line1' },
    { target: 'seller.address.postalCode', source: 'vendor.addr.zip' },
    { target: 'seller.address.city', source: 'vendor.addr.town' },
    { target: 'seller.address.province', source: 'vendor.addr.prov' },
    { target: 'seller.address.country', literal: 'IT' },
    { target: 'buyer.vatId.country', literal: 'IT' },
    { target: 'buyer.vatId.code', source: 'customer.vat' },
    { target: 'buyer.name', source: 'customer.name' },
    { target: 'buyer.address.street', source: 'customer.addr.line1' },
    { target: 'buyer.address.postalCode', source: 'customer.addr.zip' },
    { target: 'buyer.address.city', source: 'customer.addr.town' },
    { target: 'buyer.address.province', source: 'customer.addr.prov' },
    { target: 'buyer.address.country', literal: 'IT' },
    { target: 'lines[].lineNumber', source: 'items[].idx' },
    { target: 'lines[].description', source: 'items[].desc' },
    { target: 'lines[].unitPrice', source: 'items[].cents',
      transform: [{ fn: 'divide', arg: 100 }, { fn: 'toDecimalString', arg: 2 }] },
    { target: 'lines[].totalPrice', source: 'items[].cents',
      transform: [{ fn: 'divide', arg: 100 }, { fn: 'toDecimalString', arg: 2 }] },
    { target: 'lines[].vatRate', source: 'items[].vat_pct',
      transform: [{ fn: 'toDecimalString', arg: 2 }] },
    { target: 'summaries[].vatRate', source: 'vat_totals[].pct',
      transform: [{ fn: 'toDecimalString', arg: 2 }] },
    { target: 'summaries[].taxableAmount', source: 'vat_totals[].base_cents',
      transform: [{ fn: 'divide', arg: 100 }, { fn: 'toDecimalString', arg: 2 }] },
    { target: 'summaries[].taxAmount', source: 'vat_totals[].tax_cents',
      transform: [{ fn: 'divide', arg: 100 }, { fn: 'toDecimalString', arg: 2 }] },
  ],
});

/** The CRM's OWN shape — nothing here matches the canonical model. */
const crmPayload = (over: Record<string, unknown> = {}) => ({
  doc_no: `ACME-${Math.random().toString(36).slice(2, 8)}`,
  doc_date: '2026-09-02',
  vendor: { vat: '01234567890', name: 'Fornitore S.r.l.',
    addr: { line1: 'Via Roma 1', zip: '20100', town: 'Milano', prov: 'MI' } },
  customer: { vat: '09876543210', name: 'Cliente S.p.A.', sdi_code: 'ABC1234',
    addr: { line1: 'Via Milano 2', zip: '00100', town: 'Roma', prov: 'RM' } },
  items: [{ idx: 1, desc: 'Consulenza', cents: 100_000, vat_pct: 22 }],
  vat_totals: [{ pct: 22, base_cents: 100_000, tax_cents: 22_000 }],
  ...over,
});

const saveTemplate = (t: object = template()) =>
  request(h.app).post(`/api/v1/admin/tenants/${tenantId}/transformations`)
    .set(admin()).send(t);

const submit = (body: object) =>
  request(h.app).post('/api/v1/invoices').set(auth()).send(body);

describe('transformation applied to a submission', () => {
  it('maps a CRM-shaped payload into a valid FatturaPA submission', async () => {
    await saveTemplate();
    const r = await submit({ sellerId, transformation: 'acme', invoice: crmPayload() });
    expect(r.status).toBe(202);
    expect(r.body.submissionId).toBeTruthy();
  });

  /**
   * The conversion that matters most: FatturaPA amounts are patterned STRINGS
   * with exactly two decimals. A CRM holding integer cents produces a
   * schema-invalid document unless the template converts — and XSD validation
   * runs before transmission, so a wrong conversion fails loudly here.
   */
  it('converts integer cents to the mandatory 2-decimal string', async () => {
    await saveTemplate();
    const r = await submit({ sellerId, transformation: 'acme', invoice: crmPayload() });
    const xml = await request(h.app)
      .get(`/api/v1/invoices/${r.body.submissionId}/xml`).set(auth());
    expect(xml.text).toContain('<PrezzoUnitario>1000.00<');
    expect(xml.text).toContain('<ImponibileImporto>1000.00<');
    expect(xml.text).toContain('<Imposta>220.00<');
    expect(xml.text).toContain('<AliquotaIVA>22.00<');
  });

  it('the untransformed CRM payload would NOT submit — proving the mapping did the work', async () => {
    const r = await submit({ sellerId, invoice: crmPayload() });   // no transformation
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('ERR_SCHEMA_INVALID');
  });

  it('names BOTH paths when a required source field is missing', async () => {
    await saveTemplate();
    const bad = crmPayload();
    delete (bad as Record<string, unknown>)['doc_no'];
    const r = await submit({ sellerId, transformation: 'acme', invoice: bad });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('ERR_TRANSFORM_FAILED');
    // The CRM recognises "doc_no"; "number" alone would be useless to them.
    expect(r.body.error.details[0].sourcePath).toBe('doc_no');
    expect(r.body.error.details[0].targetPath).toBe('number');
  });

  it('404s on a transformation the tenant does not have', async () => {
    const r = await submit({ sellerId, transformation: 'nope', invoice: crmPayload() });
    expect(r.status).toBe(404);
  });

  it('submits canonical payloads unchanged when no transformation is named', async () => {
    const { validInvoice } = await import('../helpers/harness.ts');
    const r = await submit({ sellerId, invoice: validInvoice() });
    expect(r.status).toBe(202);
  });

  it('is TENANT-SCOPED — another tenant cannot use this template', async () => {
    await saveTemplate();
    const other = await seedTenant(h);
    const r = await request(h.app).post('/api/v1/invoices')
      .set({ authorization: `Bearer ${other.apiKey}` })
      .send({ sellerId: other.sellerId, transformation: 'acme', invoice: crmPayload() });
    expect(r.status).toBe(404);
  });
});

describe('transformation lifecycle', () => {
  it('re-saving the same name UPDATES rather than duplicating', async () => {
    const first = await saveTemplate(template('dupe'));
    expect(first.status).toBe(201);
    const second = await saveTemplate(template('dupe'));
    expect(second.status).toBe(200);        // updated, not created
    const list = await request(h.app)
      .get(`/api/v1/admin/tenants/${tenantId}/transformations`).set(admin());
    expect(list.body.data.filter((t: { name: string }) => t.name === 'dupe')).toHaveLength(1);
  });

  it('lists templates with a rule count, never the full rule bodies', async () => {
    await saveTemplate();
    const r = await request(h.app)
      .get(`/api/v1/admin/tenants/${tenantId}/transformations`).set(admin());
    const acme = r.body.data.find((t: { name: string }) => t.name === 'acme');
    expect(acme.rule_count).toBeGreaterThan(0);
    expect(acme.rules).toBeUndefined();
  });

  it('fetches one template in full, so a CRM can round-trip its own config', async () => {
    await saveTemplate();
    const r = await request(h.app)
      .get(`/api/v1/admin/tenants/${tenantId}/transformations/acme`).set(admin());
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data.rules)).toBe(true);
  });

  it('deletes a template and then refuses to use it', async () => {
    await saveTemplate(template('temp'));
    const del = await request(h.app)
      .delete(`/api/v1/admin/tenants/${tenantId}/transformations/temp`).set(admin());
    expect(del.status).toBe(204);
    const r = await submit({ sellerId, transformation: 'temp', invoice: crmPayload() });
    expect(r.status).toBe(404);
  });

  it('404s when deleting a template that does not exist', async () => {
    const r = await request(h.app)
      .delete(`/api/v1/admin/tenants/${tenantId}/transformations/ghost`).set(admin());
    expect(r.status).toBe(404);
  });

  /**
   * The whitelist is re-checked when a template is LOADED, not only when saved:
   * a row can be edited by anything with database access, and the whitelist is
   * the only thing between a stored rule and function dispatch.
   */
  it('refuses a rule naming a function outside the whitelist, at save time', async () => {
    const r = await saveTemplate({
      name: 'evil', rules: [{ target: 'number', source: 'x',
        transform: [{ fn: 'eval' }] }],
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

/**
 * XFORM-015 — the dry-run endpoint, the primary authoring surface.
 *
 * Without it the only way to test a mapping is to submit a real invoice, and a
 * real invoice carrying a wrong mapping is LEGALLY ISSUED the moment SdI
 * accepts it. The trace is what makes a wrong mapping self-diagnosing.
 */
describe('transformation dry run', () => {
  const dryRun = (body: object) =>
    request(h.app).post('/api/v1/transformations/test').set(auth()).send(body);

  it('runs a SAVED template and reports the canonical result', async () => {
    await saveTemplate();
    const r = await dryRun({ transformation: 'acme', payload: crmPayload() });
    expect(r.status).toBe(200);
    expect(r.body.canonicalValid).toBe(true);
    expect(r.body.errors).toHaveLength(0);
  });

  it('SUBMITS NOTHING — no submission row appears', async () => {
    await saveTemplate();
    const before = await request(h.app).get('/api/v1/pending').set(auth());
    await dryRun({ transformation: 'acme', payload: crmPayload() });
    const after = await request(h.app).get('/api/v1/pending').set(auth());
    expect(r0(after)).toBe(r0(before));
    expect((await dryRun({ transformation: 'acme', payload: crmPayload() })).body.submitted)
      .toBe(false);
  });
  const r0 = (res: { body: { data?: unknown[] } }) => (res.body.data ?? []).length;

  it('accepts an INLINE template so a mapping can be iterated before saving', async () => {
    const r = await dryRun({
      template: { name: 'draft', rules: [{ target: 'number', source: 'doc_no' }] },
      payload: { doc_no: 'X-1' },
    });
    expect(r.status).toBe(200);
    expect(r.body.output.number).toBe('X-1');
  });

  /**
   * The money trace is the reason this endpoint exists. CRM cents need
   * `divide(100)`; writing `multiply(100)` yields a plausible-looking number
   * that is wrong by 10,000x, and only the step-by-step values reveal it.
   */
  it('traces source value through EVERY step to the final value', async () => {
    await saveTemplate();
    const r = await dryRun({ transformation: 'acme', payload: crmPayload() });
    const t = r.body.trace.find((x: { target: string }) => x.target === 'lines[0].unitPrice');
    expect(t.sourceValue).toBe(100_000);
    expect(t.steps.map((s: { fn: string }) => s.fn)).toEqual(['divide', 'toDecimalString']);
    expect(t.steps[0].out).toBe('1000');
    expect(t.result).toBe('1000.00');
  });

  it('ACCUMULATES every error rather than stopping at the first', async () => {
    const r = await dryRun({
      template: { name: 'draft', rules: [
        { target: 'number', source: 'a', required: true },
        { target: 'date', source: 'b', required: true },
        { target: 'currency', source: 'c', required: true },
      ] },
      payload: {},
    });
    // One round-trip, three problems — not three deploys.
    expect(r.body.errors).toHaveLength(3);
    expect(r.body.errors.map((e: { targetPath: string }) => e.targetPath))
      .toEqual(['number', 'date', 'currency']);
  });

  it('reports canonical-model failures too, not just rule failures', async () => {
    const r = await dryRun({
      template: { name: 'draft', rules: [{ target: 'number', source: 'doc_no' }] },
      payload: { doc_no: 'X-1' },
    });
    expect(r.body.errors).toHaveLength(0);          // every rule ran
    expect(r.body.canonicalValid).toBe(false);      // but it is not submittable
    expect(r.body.canonicalErrors.length).toBeGreaterThan(0);
  });

  it('names both paths on a failing rule inside an array', async () => {
    const r = await dryRun({
      template: { name: 'draft', rules: [
        { target: 'lines[].description', source: 'items[].missing', required: true },
      ] },
      payload: { items: [{ other: 1 }] },
    });
    expect(r.body.errors[0].sourcePath).toBe('items[0].missing');
    expect(r.body.errors[0].targetPath).toBe('lines[0].description');
  });

  it('reports a missing source array instead of silently producing nothing', async () => {
    const r = await dryRun({
      template: { name: 'draft', rules: [
        { target: 'lines[].description', source: 'items[].desc' },
      ] },
      payload: { not_items: [] },
    });
    expect(r.body.errors[0].message).toMatch(/source array not found/);
  });

  it('rejects a non-whitelisted function in an INLINE template too', async () => {
    const r = await dryRun({
      template: { name: 'draft', rules: [
        { target: 'number', source: 'a', transform: [{ fn: 'eval' }] },
      ] },
      payload: { a: 1 },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it('requires a payload', async () => {
    expect((await dryRun({ transformation: 'acme' })).status).toBe(400);
  });

  it('requires either a saved name or an inline template', async () => {
    expect((await dryRun({ payload: {} })).status).toBe(400);
  });

  it('is TENANT-SCOPED — cannot dry-run another tenant template', async () => {
    await saveTemplate();
    const other = await seedTenant(h);
    const r = await request(h.app).post('/api/v1/transformations/test')
      .set({ authorization: `Bearer ${other.apiKey}` })
      .send({ transformation: 'acme', payload: crmPayload() });
    expect(r.status).toBe(404);
  });
});

/**
 * Starter templates (XFORM-017 / XFORM-018).
 *
 * "Verified" means written against the canonical model here and exercised by
 * tests — NOT that they match any particular CRM's output. A starter claiming
 * to map a named third-party CRM nobody has inspected would be worse than
 * none: it looks authoritative and produces a plausible invoice with the wrong
 * values.
 */
describe('starter templates', () => {
  const list = () => request(h.app).get('/api/v1/starter-templates').set(auth());
  const clone = (key: string, name?: string) =>
    request(h.app).post(`/api/v1/transformations/from-starter/${key}`)
      .set(auth()).send(name ? { name } : {});

  it('publishes the three verified starters', async () => {
    const r = await list();
    expect(r.body.data.map((s: { key: string }) => s.key))
      .toEqual(['passthrough', 'generic-cents', 'generic-decimal']);
  });

  it('states plainly that no third-party CRM template ships', async () => {
    const r = await list();
    expect(r.body.note).toMatch(/Wave, Zoho or any other named CRM/);
    expect(r.body.note).toMatch(/worse than none/);
  });

  it('CLONES into the tenant own transformations, not a shared row', async () => {
    const r = await clone('generic-cents', 'cloned-a');
    expect([200, 201]).toContain(r.status);
    const mine = await request(h.app)
      .get(`/api/v1/admin/tenants/${tenantId}/transformations`).set(admin());
    expect(mine.body.data.map((t: { name: string }) => t.name)).toContain('cloned-a');
  });

  it('an edit to the clone does NOT change the starter', async () => {
    await clone('passthrough', 'edit-me');
    await request(h.app).post(`/api/v1/admin/tenants/${tenantId}/transformations`)
      .set(admin()).send({ name: 'edit-me', rules: [{ target: 'number', source: 'x' }] });
    const starter = await request(h.app)
      .get('/api/v1/starter-templates/passthrough').set(auth());
    // The starter is code, not a row — it cannot be edited by a tenant at all.
    expect(starter.body.data.template.rules.length).toBeGreaterThan(1);
  });

  /**
   * The money conversion is why two of these exist. A starter that produced a
   * bare integer would teach the exact mistake it is meant to prevent.
   */
  it('generic-cents PRODUCES valid FatturaPA money from integer cents', async () => {
    await clone('generic-cents', 'cents-test');
    const r = await request(h.app).post('/api/v1/transformations/test').set(auth())
      .send({
        transformation: 'cents-test',
        payload: {
          invoice_number: 'ST/1', invoice_date: '2026-09-02', recipient_code: 'ABC1234',
          seller: { name: 'F', tax_regime: 'RF01', vat_number: '01234567890' },
          buyer: { name: 'C', vat_number: '09876543210' },
          lines: [{ position: 1, description: 'S', unitPrice: 100_000,
                    totalPrice: 100_000, vat_percent: 22 }],
        },
      });
    // 100000 cents must become "1000.00", not "10000000.00".
    expect(r.body.output.lines[0].unitPrice).toBe('1000.00');
    expect(r.body.errors).toHaveLength(0);
  });

  it('generic-decimal converts a JSON number to the mandatory string form', async () => {
    await clone('generic-decimal', 'dec-test');
    const r = await request(h.app).post('/api/v1/transformations/test').set(auth())
      .send({
        transformation: 'dec-test',
        payload: {
          invoice_number: 'ST/2', invoice_date: '02/09/2026', recipient_code: 'ABC1234',
          seller: { name: 'F', tax_regime: 'RF01', vat_number: '01234567890' },
          buyer: { name: 'C', vat_number: '09876543210' },
          lines: [{ position: 1, description: 'S', unitPrice: 1000.5,
                    totalPrice: 1000.5, vat_percent: 22 }],
        },
      });
    // A JSON number serialises as 1000.5, which is schema-invalid.
    expect(r.body.output.lines[0].unitPrice).toBe('1000.50');
    expect(r.body.output.date).toBe('2026-09-02');
  });

  it('404s on an unknown starter key', async () => {
    expect((await clone('does-not-exist')).status).toBe(404);
  });

  it('every shipped starter passes the template validator', async () => {
    const { STARTER_TEMPLATES } = await import('../../src/domain/transform/starters.ts');
    const { validateTemplate } = await import('../../src/domain/transform/engine.ts');
    for (const s of STARTER_TEMPLATES) {
      expect(() => validateTemplate(s.template), s.key).not.toThrow();
    }
  });
});
