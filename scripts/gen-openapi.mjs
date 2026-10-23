#!/usr/bin/env node
/**
 * Generate the OpenAPI 3.0 contract from the Zod schemas.
 *
 * GENERATED, not hand-written, for one reason: a hand-maintained contract
 * drifts from the validation that actually runs, and an integrator who trusts
 * a stale contract builds against an API that does not exist. Deriving the
 * schemas means the two cannot disagree — if validation changes, so does the
 * published contract, or CI fails.
 *
 *   node scripts/gen-openapi.mjs [--check]
 *
 * `--check` fails when the committed spec is stale (DOC-006's CI gate).
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const OUT = 'docs/public/openapi.json';

// Import through Node's type stripping — the schemas are the source of truth.
const mod = await import('../src/domain/invoice/model.ts');
const events = await import('../src/domain/webhook/events.ts');
const scopes = await import('../src/domain/apikey/scopes.ts');
const catalog = await import('../src/shared/errors/catalog.ts');
const sdi = await import('../src/shared/errors/sdi-errors.ts');
const { zodToJsonSchema } = await import('zod-to-json-schema');

const json = (schema, name) =>
  zodToJsonSchema(schema, { name, target: 'openApi3', $refStrategy: 'none' });

const InvoiceSchema = json(mod.InvoiceSchema, 'Invoice').definitions.Invoice;

const errorResponse = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', enum: Object.keys(catalog.ERRORS ?? {}) },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
        details: { type: 'array', items: {} },
      },
      required: ['code', 'message', 'retryable'],
    },
    requestId: { type: 'string' },
  },
};

const err = (code, description) => ({
  description,
  content: { 'application/json': { schema: errorResponse } },
});

const RATE_HEADERS = {
  'X-RateLimit-Limit': { schema: { type: 'string' }, description: 'Requests allowed per window' },
  'X-RateLimit-Remaining': { schema: { type: 'string' }, description: 'Requests left in this window' },
  'X-RateLimit-Reset': { schema: { type: 'string' }, description: 'Seconds until the window resets' },
};

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'PASSO',
    version: JSON.parse(readFileSync('package.json', 'utf8')).version,
    description: [
      'Italian e-invoicing relay: CRM to Sistema di Interscambio via a pluggable channel.',
      '',
      '**Three rules that catch most integrations:**',
      '',
      '1. **NS is terminal.** The invoice is legally *not issued*. Fix it and submit a NEW',
      '   invoice — `/retry` refuses with 409. Auto-retrying sends a duplicate to the tax authority.',
      '2. **MC is not a failure.** The invoice IS issued; SdI is still delivering. Do not resubmit.',
      '3. **Money is a string.** `"1000.00"`, never `1000`. FatturaPA amounts are patterned',
      '   strings with exactly two decimals; a bare integer is schema-invalid.',
      '',
      '**Dual mode.** `mode: "async"` (default) returns 202 and reports progress by webhook.',
      '`mode: "sync"` holds the connection until the invoice reaches SdI — it waits for the',
      '**AT milestone only**, never RC, MC or DT, because MC delivery retry legally runs for',
      'days and no HTTP timeout can represent it. On timeout you get a 202 and the job',
      'continues untouched.',
      '',
      'PASSO keeps **no invoice archive**. Payloads are purged once a terminal receipt',
      'arrives; fetch what you need before then. Purged submissions return `410 Gone`.',
    ].join('\n'),
    license: { name: 'AGPL-3.0-or-later' },
  },
  servers: [{ url: '/api/v1', description: 'API root' }],
  components: {
    securitySchemes: {
      ApiKey: { type: 'http', scheme: 'bearer', description: 'A tenant API key (`passo_…`)' },
      AdminKey: { type: 'http', scheme: 'bearer', description: 'The master admin key, set at install' },
    },
    schemas: {
      Invoice: InvoiceSchema,
      Error: errorResponse,
      SubmissionAccepted: {
        type: 'object',
        properties: {
          submissionId: { type: 'string', format: 'uuid' },
          status: { type: 'string' },
          invoiceNumber: { type: 'string' },
          progressivoInvio: { type: 'string' },
          fileName: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
          trackingUrl: { type: 'string', format: 'uri' },
        },
      },
    },
  },
  security: [{ ApiKey: [] }],
  tags: [
    { name: 'Invoices', description: 'Submit and track invoices' },
    { name: 'Transformations', description: 'Map your CRM shape onto the canonical model' },
    { name: 'Webhooks', description: 'Subscriptions and delivery history' },
    { name: 'Reference', description: 'Error codes, events and scopes' },
    { name: 'Admin', description: 'Operator surface — requires the admin key' },
  ],
  paths: {
    '/invoices': {
      post: {
        tags: ['Invoices'], summary: 'Submit an invoice', operationId: 'submitInvoice',
        parameters: [{
          name: 'idempotency-key', in: 'header', schema: { type: 'string' },
          description: 'Replaying the same key returns the original result; a different body is a 409.',
        }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['sellerId', 'invoice'],
            properties: {
              sellerId: { type: 'string', format: 'uuid' },
              invoice: { oneOf: [{ $ref: '#/components/schemas/Invoice' }, { type: 'object' }],
                description: 'Canonical model, or your own shape when `transformation` is set' },
              transformation: { type: 'string',
                description: 'Name of a saved template. Never applied implicitly.' },
              crmInvoiceRef: { type: 'string' },
              mode: { type: 'string', enum: ['async', 'sync'], default: 'async' },
              syncTimeoutMs: { type: 'integer',
                description: 'Capped server-side; never raises the configured maximum.' },
            },
          } } },
        },
        responses: {
          202: { description: 'Accepted and queued', headers: RATE_HEADERS,
                 content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmissionAccepted' } } } },
          200: { description: 'Sync mode: the AT milestone was reached before the timeout',
                 content: { 'application/json': { schema: { $ref: '#/components/schemas/SubmissionAccepted' } } } },
          400: err(400, 'Schema or transformation failure — both source and target paths are named'),
          401: err(401, 'Missing or invalid API key'),
          403: err(403, 'The key lacks `invoices:write`; the response names the required scope'),
          409: err(409, 'Idempotency key reused with a different body'),
          413: err(413, 'Body exceeds the size limit'),
          429: err(429, 'Rate limited — see Retry-After'),
        },
      },
      get: {
        tags: ['Invoices'], summary: 'List submissions', operationId: 'listInvoices',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'sellerId', in: 'query', schema: { type: 'string', format: 'uuid' } },
          { name: 'documentType', in: 'query', schema: { type: 'string' } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200, default: 50 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' },
            description: 'Opaque `nextCursor` from the previous page. Cursor, not offset: an offset skips rows under concurrent inserts.' },
        ],
        responses: { 200: { description: 'A page of submissions' }, 403: err(403, 'Requires `invoices:read`') },
      },
    },
    '/invoices/{id}': {
      get: {
        tags: ['Invoices'], summary: 'Submission status', operationId: 'getInvoice',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'Status plus any receipts, with SdI rejection codes enriched' },
          404: err(404, 'Not found, or belongs to another tenant — deliberately indistinguishable'),
        },
      },
    },
    '/invoices/{id}/receipts': {
      get: {
        tags: ['Invoices'], summary: 'SdI receipts for a submission', operationId: 'getInvoiceReceipts',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'Every notification, oldest first' },
                     404: err(404, 'Not found, or belongs to another tenant') },
      },
    },
    '/invoices/{id}/ack': {
      post: {
        tags: ['Invoices'], summary: 'Acknowledge receipts', operationId: 'ackInvoiceReceipts',
        description: 'Makes receipts purge-eligible after RECEIPT_ACK_GRACE_DAYS. A replay is a no-op.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: '{ acknowledged: n }' } },
      },
    },
    '/render': {
      post: {
        tags: ['Invoices'], summary: 'Render arbitrary FatturaPA or notification XML',
        operationId: 'renderXml',
        description: 'Official AdE stylesheet. Lets a CRM display an invoice PASSO has already purged.',
        parameters: [{ name: 'type', in: 'query', schema: { type: 'string' },
                       description: 'Notification type (RC, NS, …) when the body is a receipt' }],
        requestBody: { required: true, content: { 'application/xml': { schema: { type: 'string' } } } },
        responses: { 200: { description: 'HTML', content: { 'text/html': {} } },
                     400: err(400, 'Empty body or over PASSO_MAX_RENDER_BYTES') },
      },
    },
    '/invoices/{id}/retry': {
      post: {
        tags: ['Invoices'], summary: 'Retry a failed submission', operationId: 'retryInvoice',
        description: 'REFUSES an NS (terminal — issue a new invoice) and an MC (still delivering).',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 202: { description: 'Requeued' }, 409: err(409, 'NS or MC — retrying would duplicate at the tax authority') },
      },
    },
    '/invoices/{id}/xml': {
      get: {
        tags: ['Invoices'], summary: 'The transmitted FatturaPA XML', operationId: 'getInvoiceXml',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'XML', content: { 'application/xml': {} } },
                     410: err(410, 'Purged after a terminal receipt — PASSO is a relay, not an archive') },
      },
    },
    '/invoices/{id}/rendered': {
      get: {
        tags: ['Invoices'], summary: 'Human-readable rendering via the official AdE stylesheet',
        operationId: 'getInvoiceRendered',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'HTML', content: { 'text/html': {} } }, 410: err(410, 'Purged') },
      },
    },
    '/starter-templates': {
      get: {
        tags: ['Transformations'], summary: 'List starter templates', operationId: 'listStarterTemplates',
        description: 'Teaching examples. Not mappings for a named CRM.',
        responses: { 200: { description: 'key, name, description, suits, rule count' } },
      },
    },
    '/starter-templates/{key}': {
      get: {
        tags: ['Transformations'], summary: 'One starter template', operationId: 'getStarterTemplate',
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Full template including rules' },
                     404: err(404, 'Unknown starter') },
      },
    },
    '/transformations/from-starter/{key}': {
      post: {
        tags: ['Transformations'], summary: 'Clone a starter into this tenant',
        operationId: 'cloneStarterTemplate',
        parameters: [{ name: 'key', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: {
          type: 'object', properties: { name: { type: 'string' } },
        } } } },
        responses: { 201: { description: 'Created' }, 200: { description: 'Replaced existing name' },
                     404: err(404, 'Unknown starter') },
      },
    },
    '/transformations/test': {
      post: {
        tags: ['Transformations'], summary: 'Dry-run a mapping', operationId: 'testTransformation',
        description: 'Submits nothing, queues nothing, persists nothing. Returns a per-rule trace and EVERY error at once.',
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['payload'],
          properties: {
            payload: { type: 'object', description: 'Your CRM-shaped invoice' },
            transformation: { type: 'string', description: 'A saved template name' },
            template: { type: 'object', description: 'An inline unsaved template, to iterate before saving' },
          },
        } } } },
        responses: { 200: { description: 'output, trace, errors, canonicalValid' },
                     400: err(400, 'Neither a name nor an inline template was supplied') },
      },
    },
    '/webhooks': {
      post: {
        tags: ['Webhooks'], summary: 'Create a subscription', operationId: 'createWebhook',
        description: 'The signing secret is returned ONCE and never again.',
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['callbackUrl'],
          properties: {
            callbackUrl: { type: 'string', format: 'uri' },
            events: { type: 'array', items: { type: 'string', enum: [...events.WEBHOOK_EVENTS] } },
            description: { type: 'string' },
          },
        } } } },
        responses: { 201: { description: 'Created; `secret` is shown once' },
                     400: err(400, 'Unknown event, or a callback URL that resolves to a private range') },
      },
      get: { tags: ['Webhooks'], summary: 'List subscriptions', operationId: 'listWebhooks',
             responses: { 200: { description: 'Subscriptions — secrets are never returned' } } },
    },
    '/webhooks/{id}': {
      patch: {
        tags: ['Webhooks'], summary: 'Update a subscription', operationId: 'updateWebhook',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: { content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            callbackUrl: { type: 'string', format: 'uri' },
            events: { type: 'array', items: { type: 'string' } },
            description: { type: 'string' },
            active: { type: 'boolean' },
          },
        } } } },
        responses: { 200: { description: 'Updated' }, 404: err(404, 'Unknown webhook') },
      },
      delete: {
        tags: ['Webhooks'], summary: 'Delete a subscription', operationId: 'deleteWebhook',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 204: { description: 'Deleted' }, 404: err(404, 'Unknown webhook') },
      },
    },
    '/webhooks/{id}/rotate-secret': {
      post: {
        tags: ['Webhooks'], summary: 'Rotate the signing secret', operationId: 'rotateWebhookSecret',
        description: 'Both signatures are sent during the overlap window, so a receiver can redeploy without downtime. Parse EVERY `v1=` in the header, not just the last.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'The new secret and the overlap window' } },
      },
    },
    '/webhooks/{id}/deliveries': {
      get: {
        tags: ['Webhooks'], summary: 'Delivery history', operationId: 'listWebhookDeliveries',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'eventType', in: 'query', schema: { type: 'string' } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['delivered', 'failed'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', maximum: 200 } },
        ],
        responses: { 200: { description: 'Attempts, status codes and errors' } },
      },
    },
    '/invoices/{id}/export': {
      get: {
        tags: ['Invoices'], summary: 'Pre-purge export package', operationId: 'exportInvoice',
        description:
          'Everything PASSO holds for one submission — XML, rendering, receipts and hashes — ' +
          'in one call. Hashes are computed over the PLAINTEXT XML bytes so you can verify ' +
          'them independently. Take this BEFORE the terminal receipt arrives: afterwards the ' +
          'payload is purged and this returns 410.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'The complete package' },
          410: err(410, 'Purged — PASSO holds no archive and there is no recovery path'),
        },
      },
    },
    '/privacy/erasure': {
      post: {
        tags: ['Reference'], summary: 'Data-subject erasure enquiry', operationId: 'erasureRequest',
        description:
          'Reports what PASSO actually holds for a subject. Almost always: nothing beyond ' +
          'configuration, because the CRM holds the archive. An in-flight document is refused ' +
          'for the LIVE TRANSMISSION, never for a retention duty PASSO does not have.',
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object',
          properties: { vatId: { type: 'string' }, taxCode: { type: 'string' },
                        subjectRef: { type: 'string' } },
        } } } },
        responses: { 200: { description: 'What is held, and whether it is erasable' },
                     400: err(400, 'No subject identifier supplied') },
      },
    },
    '/inbound/{token}': {
      post: {
        tags: ['Webhooks'], summary: 'Vendor notification callback', operationId: 'inboundNotification',
        security: [],
        description:
          'Where Invoicetronic and OpenAPI.it push receipts. Authenticated by the per-tenant ' +
          'token in the path — vendor consoles frequently cannot send custom headers. Returns ' +
          '200 even for a duplicate or a quarantine, so the vendor stops retrying something ' +
          'already handled.',
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/xml': {} } },
        responses: {
          200: { description: 'Received (applied, duplicate or quarantined)' },
          400: err(400, 'Unparseable — the payload is never echoed back'),
          401: err(401, 'Unknown token'),
          413: err(413, 'Body exceeds the inbound limit, refused before parsing'),
        },
      },
    },
    '/webhook-events': {
      get: { tags: ['Reference'], summary: 'Event catalogue', operationId: 'listWebhookEvents',
             responses: { 200: { description: 'Each event with terminal / legallyIssued / action' } } },
    },
    '/sdi-errors': {
      get: { tags: ['Reference'], summary: 'The 63 SdI rejection codes', operationId: 'listSdiErrors',
             responses: { 200: { description: `${sdi.SDI_ERROR_COUNT} codes with descriptions and remedies` } } },
    },
    '/sdi-errors/{code}': {
      get: {
        tags: ['Reference'], summary: 'One SdI rejection code', operationId: 'getSdiError',
        parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Code, description and remedy' } },
      },
    },
    '/scopes': {
      get: { tags: ['Reference'], summary: 'API key scopes', operationId: 'listScopes',
             responses: { 200: { description: `${scopes.SCOPES.length} scopes` } } },
    },
    '/pending': {
      get: { tags: ['Invoices'], summary: 'Submissions awaiting acknowledgement', operationId: 'listPending',
             responses: { 200: { description: 'Unacknowledged receipts — these are never purged' } } },
    },
    '/health/live': {
      get: { tags: ['Reference'], summary: 'Liveness', operationId: 'healthLive', security: [],
             responses: { 200: { description: 'The process is up. Checks nothing external.' } } },
    },
    '/health/ready': {
      get: { tags: ['Reference'], summary: 'Readiness', operationId: 'healthReady', security: [],
             description: 'Postgres, RabbitMQ and Redis. Deliberately EXCLUDES SdI vendors: a vendor outage must not take PASSO out of rotation.',
             responses: { 200: { description: 'Ready' }, 503: { description: 'A dependency is down' } } },
    },
  },
};

const rendered = `${JSON.stringify(spec, null, 2)}\n`;

/**
 * Render the endpoint tables as STATIC markdown.
 *
 * The interactive viewer is a convenience loaded from a CDN; it is not the
 * reference. A page whose only content arrives over the network is a blank div
 * wherever that CDN is unreachable — and DOC-007 asks that every endpoint in
 * the spec appear in the site, which a blank div does not satisfy.
 */
function renderMarkdown(s) {
  const byTag = new Map();
  for (const [path, ops] of Object.entries(s.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const tag = (op.tags ?? ['Other'])[0];
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push({ path, method: method.toUpperCase(), op });
    }
  }
  const out = [];
  out.push('<!-- GENERATED by scripts/gen-openapi.mjs — do not edit. -->');
  out.push('');
  for (const tag of s.tags.map((t) => t.name)) {
    const rows = byTag.get(tag);
    if (!rows) continue;
    const meta = s.tags.find((t) => t.name === tag);
    out.push(`### ${tag}`);
    out.push('');
    if (meta?.description) { out.push(`${meta.description}.`); out.push(''); }
    for (const { path, method, op } of rows) {
      out.push(`#### \`${method} ${path}\``);
      out.push('');
      if (op.summary) out.push(`**${op.summary}**`);
      if (op.description) { out.push(''); out.push(op.description); }
      out.push('');
      const params = op.parameters ?? [];
      if (params.length) {
        out.push('| Parameter | In | Type | Notes |');
        out.push('|---|---|---|---|');
        for (const p of params) {
          const t = p.schema?.type ?? '—';
          out.push(`| \`${p.name}\` | ${p.in} | ${t} | ${(p.description ?? '').replace(/\|/g, '\\|')} |`);
        }
        out.push('');
      }
      out.push('| Status | Meaning |');
      out.push('|---|---|');
      for (const [code, r] of Object.entries(op.responses ?? {})) {
        out.push(`| \`${code}\` | ${(r.description ?? '').replace(/\|/g, '\\|')} |`);
      }
      out.push('');
    }
  }
  return out.join('\n');
}

if (process.argv.includes('--check')) {
  if (!existsSync(OUT)) { console.error(`FAILED: ${OUT} is missing — run: npm run gen:openapi`); process.exit(1); }
  if (readFileSync(OUT, 'utf8') !== rendered) {
    console.error(`FAILED: ${OUT} is STALE. A schema changed without regenerating the contract.`);
    console.error('Run: npm run gen:openapi');
    process.exit(1);
  }
  console.error(`${OUT} is up to date (${Object.keys(spec.paths).length} paths)`);
} else {
  execFileSync('mkdir', ['-p', 'docs/public']);
  writeFileSync(OUT, rendered);
  writeFileSync('docs/api/_endpoints.md', `${renderMarkdown(spec)}\n`);
  console.error(`wrote ${OUT}: ${Object.keys(spec.paths).length} paths`);
  console.error('wrote docs/api/_endpoints.md');
}
