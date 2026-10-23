import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { withTenant } from '../../src/infra/db/pool.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import { submitInvoice } from '../../src/domain/submission/service.ts';
import { MockChannel } from '../../src/infra/channels/mock.ts';
import { logger } from '../../src/shared/logger.ts';
import { STATE } from '../../src/domain/submission/state.ts';
import {
  } from '@modelcontextprotocol/sdk/types.js';
import { createHarness, seedTenant, type Harness } from '../helpers/harness.ts';

const h: Harness = createHarness();
const db = h.db;
const keys = h.keys;
let A = '';
let B = '';
let sellerId = '';
afterAll(async () => { await h.close(); });
beforeAll(async () => {
  const seeded = await seedTenant(h);
  A = seeded.tenantId;
  sellerId = seeded.sellerId;
  B = (await seedTenant(h)).tenantId;
});

/** Reach the registered handler without a transport. */
const call = async (tenantId: string, name: string, args: Record<string, unknown> = {}) => {
  const server = createMcpServer({ db, tenantId, log: logger });
  const handler = (server as unknown as {
    _requestHandlers: Map<string, (r: unknown) => Promise<{ content: Array<{ text: string }> }>>;
  })._requestHandlers.get('tools/call')!;
  const res = await handler({ method: 'tools/call', params: { name, arguments: args } });
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};

const submit = () => submitInvoice(db, keys, {
  documentType: 'TD01', number: `M-${Math.random().toString(36).slice(2, 8)}`,
  date: '2026-09-01', currency: 'EUR', format: 'FPR12', recipientCode: 'ABC1234',
  seller: { vatId: { country: 'IT', code: '01234567890' }, name: 'F', taxRegime: 'RF01',
    address: { street: 'V', postalCode: '20100', city: 'M', province: 'MI', country: 'IT' } },
  buyer: { vatId: { country: 'IT', code: '09876543210' }, name: 'C',
    address: { street: 'V', postalCode: '00100', city: 'R', province: 'RM', country: 'IT' } },
  lines: [{ lineNumber: 1, description: 'S', unitPrice: '10.00', totalPrice: '10.00', vatRate: '22.00' }],
  summaries: [{ vatRate: '22.00', taxableAmount: '10.00', taxAmount: '2.20' }],
}, { tenantId: A, sellerId, channel: new MockChannel() });

describe('MCP server', () => {
  it('exposes the expected tools', async () => {
    const server = createMcpServer({ db, tenantId: A, log: logger });
    const h = (server as unknown as {
      _requestHandlers: Map<string, (r: unknown) => Promise<{ tools: Array<{ name: string }> }>>;
    })._requestHandlers.get('tools/list')!;
    const names = (await h({ method: 'tools/list', params: {} })).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'list_submissions', 'get_submission', 'retry_submission', 'list_pending', 'analyse_failures',
    ]));
  });

  it('lists submissions for its tenant', async () => {
    await submit();
    const out = await call(A, 'list_submissions', { limit: 5 });
    expect(Array.isArray(out)).toBe(true);
  });

  it('IS TENANT-SCOPED — sees nothing from another tenant', async () => {
    const r = await submit();
    const asB = await call(B, 'get_submission', { submissionId: r.submissionId });
    expect((asB as { submission: unknown }).submission).toBeNull();
  });

  it('REFUSES to retry an NS and explains why', async () => {
    const r = await submit();
    await withTenant(db, A, (tx) => tx.query(
      'UPDATE sdi_submissions SET state=$2 WHERE id=$1', [r.submissionId, STATE.rejected]));
    const out = await call(A, 'retry_submission', { submissionId: r.submissionId });
    expect(out['refused']).toBe(true);
    expect(out['reason']).toBe('ERR_CONFLICT_NS_RETRY');
    expect(String(out['explanation'])).toMatch(/legally NOT issued|new invoice/i);
  });

  it('REFUSES to retry an MC — SdI is still delivering', async () => {
    const r = await submit();
    await withTenant(db, A, (tx) => tx.query(
      'UPDATE sdi_submissions SET state=$2 WHERE id=$1', [r.submissionId, STATE.awaitingDelivery]));
    const out = await call(A, 'retry_submission', { submissionId: r.submissionId });
    expect(out['refused']).toBe(true);
    expect(String(out['explanation'])).toMatch(/duplicate/i);
  });

  it('analyses rejections by SdI error code', async () => {
    const out = await call(A, 'analyse_failures', { days: 30 });
    expect(out).toHaveProperty('rejections');
  });
});

/**
 * MCP-019 — resource URIs are matched against an allowlist.
 *
 * The caller is an LLM, so unrecognised URIs are ordinary input rather than an
 * exceptional case. A substring match would answer a wrong-but-plausible
 * resource instead of failing, which is the worst outcome: the model cannot
 * tell it asked for something that does not exist.
 */
describe('MCP resources', () => {
  const readResource = async (tenantId: string, uri: string) => {
    const server = createMcpServer({ db, tenantId, log: logger });
    const handler = (server as unknown as {
      _requestHandlers: Map<string, (r: unknown) => Promise<{
        contents: Array<{ uri: string; text: string }>;
      }>>;
    })._requestHandlers.get('resources/read')!;
    return handler({ method: 'resources/read', params: { uri } });
  };

  it('serves the submissions resource', async () => {
    const r = await readResource(A, 'passo://submissions');
    expect(Array.isArray(JSON.parse(r.contents[0]!.text))).toBe(true);
  });

  it('serves the audit-log resource', async () => {
    const r = await readResource(A, 'passo://audit-log');
    expect(Array.isArray(JSON.parse(r.contents[0]!.text))).toBe(true);
  });

  it('REFUSES an unknown URI instead of silently returning something else', async () => {
    await expect(readResource(A, 'passo://secrets')).rejects.toThrow(/Unknown resource/);
  });

  it('refuses a URI that merely CONTAINS a known name', async () => {
    // A substring match would have served the audit log here.
    await expect(readResource(A, 'passo://submissions#audit-log')).rejects.toThrow(/Unknown resource/);
  });

  it('names the available resources so the model can recover', async () => {
    await expect(readResource(A, 'passo://nope')).rejects.toThrow(/passo:\/\/submissions/);
  });
});
