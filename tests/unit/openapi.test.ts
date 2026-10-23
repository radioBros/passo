import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { ERRORS } from '../../src/shared/errors/catalog.ts';
import { WEBHOOK_EVENTS } from '../../src/domain/webhook/events.ts';

/**
 * The published contract (API-023 / DOC-006).
 *
 * A hand-maintained OpenAPI file drifts from the validation that actually runs,
 * and an integrator trusting a stale contract builds against an API that does
 * not exist. The spec is therefore generated from the Zod schemas, and these
 * tests assert the generated artifact is present and coherent — the staleness
 * check itself is a CI step (`npm run check:openapi`).
 */
const spec = existsSync('docs/public/openapi.json')
  ? JSON.parse(readFileSync('docs/public/openapi.json', 'utf8'))
  : null;

describe('OpenAPI contract', () => {
  it('is generated and committed', () => {
    expect(spec, 'run `npm run gen:openapi`').not.toBeNull();
    expect(spec.openapi).toMatch(/^3\./);
  });

  it('documents every public path group', () => {
    for (const p of ['/invoices', '/invoices/{id}', '/transformations/test',
                     '/webhooks', '/sdi-errors', '/health/ready']) {
      expect(spec.paths[p], p).toBeDefined();
    }
  });

  it('derives the Invoice schema from Zod rather than restating it', () => {
    const inv = spec.components.schemas.Invoice;
    // A hand-written schema would drift; these come from InvoiceSchema itself.
    for (const f of ['documentType', 'number', 'date', 'seller', 'buyer', 'lines']) {
      expect(inv.properties[f], f).toBeDefined();
    }
  });

  it('enumerates every catalogue error code', () => {
    const enumerated: string[] = spec.components.schemas.Error
      .properties.error.properties.code.enum;
    expect(new Set(enumerated)).toEqual(new Set(Object.keys(ERRORS)));
  });

  it('enumerates every webhook event on the subscription body', () => {
    const listed = spec.paths['/webhooks'].post.requestBody
      .content['application/json'].schema.properties.events.items.enum;
    expect(new Set(listed)).toEqual(new Set(WEBHOOK_EVENTS));
  });

  /**
   * The semantics an OpenAPI schema cannot express, and which cause the most
   * expensive integration mistakes, must at least be stated in prose.
   */
  it('states the NS / MC / money rules in the description', () => {
    expect(spec.info.description).toMatch(/NS is terminal/);
    expect(spec.info.description).toMatch(/MC is not a failure/);
    expect(spec.info.description).toMatch(/Money is a string/);
  });

  it('documents that sync mode waits for AT only', () => {
    expect(spec.info.description).toMatch(/AT milestone only/);
    expect(spec.info.description).toMatch(/never RC, MC or DT/);
  });

  it('documents 410 Gone on purged payloads', () => {
    expect(spec.paths['/invoices/{id}/xml'].get.responses['410']).toBeDefined();
  });

  it('marks the health endpoints as unauthenticated', () => {
    expect(spec.paths['/health/live'].get.security).toEqual([]);
  });

  it('declares rate-limit headers on the submit response', () => {
    expect(spec.paths['/invoices'].post.responses['202'].headers)
      .toHaveProperty('X-RateLimit-Remaining');
  });
});
