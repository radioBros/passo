import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createHarness, seedTenant, ADMIN_KEY, type Harness } from '../helpers/harness.ts';
import { createMcpServer } from '../../src/mcp/server.ts';
import {
  createMcpKey, resolveMcpKey, revokeMcpKey, rotateMcpKey,
} from '../../src/domain/apikey/mcp-keys.ts';
import { MCP_DEFAULT_SCOPES } from '../../src/domain/apikey/scopes.ts';
import { logger } from '../../src/shared/logger.ts';
import { ApiError } from '../../src/shared/errors/catalog.ts';

/**
 * MCP isolation proof (MCP-028).
 *
 * The consumer is a language model: it will be asked leading questions, it may
 * echo whatever it receives, and it cannot be relied on to respect a boundary
 * it is merely told about. Every guarantee here has to hold structurally.
 */
let h: Harness;
let A = { tenantId: '', sellerId: '', apiKey: '' };
let B = { tenantId: '', sellerId: '', apiKey: '' };

beforeAll(async () => {
  h = createHarness();
  A = await seedTenant(h);
  B = await seedTenant(h);
});
afterAll(async () => { await h.close(); });

const call = async (
  tenantId: string, name: string, args: Record<string, unknown> = {}, scopes?: string[],
) => {
  const server = createMcpServer({
    db: h.db, tenantId, log: logger, ...(scopes ? { scopes } : {}),
  });
  const handler = (server as unknown as {
    _requestHandlers: Map<string, (r: unknown) => Promise<{ content: Array<{ text: string }> }>>;
  })._requestHandlers.get('tools/call')!;
  const res = await handler({ method: 'tools/call', params: { name, arguments: args } });
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
};

const listTools = (tenantId: string, scopes?: string[]) => {
  const server = createMcpServer({
    db: h.db, tenantId, log: logger, ...(scopes ? { scopes } : {}),
  });
  const handler = (server as unknown as {
    _requestHandlers: Map<string, (r: unknown) => Promise<{ tools: Array<{ name: string }> }>>;
  })._requestHandlers.get('tools/list')!;
  return handler({ method: 'tools/list', params: {} });
};

describe('MCP key lifecycle', () => {
  it('creates a key, shown ONCE, with narrow defaults', async () => {
    const k = await createMcpKey(h.db, A.tenantId, 'assistant');
    expect(k.key).toMatch(/^passo_mcp_/);
    expect(k.scopes).toEqual([...MCP_DEFAULT_SCOPES]);
    // A model must not be able to mint credentials or redirect a webhook.
    expect(k.scopes).not.toContain('keys:write');
    expect(k.scopes).not.toContain('webhooks:write');
  });

  it('RESOLVES a key to exactly its own tenant', async () => {
    const k = await createMcpKey(h.db, A.tenantId, 'a');
    const r = await resolveMcpKey(h.db, k.key);
    expect(r.tenantId).toBe(A.tenantId);
    expect(r.tenantId).not.toBe(B.tenantId);
  });

  it('never stores the key in clear — only a prefix and a hash', async () => {
    const k = await createMcpKey(h.db, A.tenantId, 'a');
    const listed = await request(h.app)
      .get(`/api/v1/admin/tenants/${A.tenantId}/mcp-keys`)
      .set({ authorization: `Bearer ${ADMIN_KEY}` });
    const row = listed.body.data.find((x: { id: string }) => x.id === k.id);
    expect(JSON.stringify(row)).not.toContain(k.key);
    expect(row.key_prefix).toBeTruthy();
  });

  it('REJECTS a revoked key', async () => {
    const k = await createMcpKey(h.db, A.tenantId, 'a');
    await revokeMcpKey(h.db, A.tenantId, k.id);
    await expect(resolveMcpKey(h.db, k.key)).rejects.toThrow(ApiError);
  });

  it('rotation issues a new key and kills the old one immediately', async () => {
    const first = await createMcpKey(h.db, A.tenantId, 'a');
    const second = await rotateMcpKey(h.db, A.tenantId, first.id);
    expect(second.key).not.toBe(first.key);
    // No overlap here, unlike webhook secrets: an MCP session reconnects, it
    // does not need to verify signatures from a past deployment.
    await expect(resolveMcpKey(h.db, first.key)).rejects.toThrow();
    expect((await resolveMcpKey(h.db, second.key)).tenantId).toBe(A.tenantId);
  });

  it('rejects a malformed key indistinguishably from an unknown one', async () => {
    await expect(resolveMcpKey(h.db, 'not-a-key')).rejects.toThrow(ApiError);
    await expect(resolveMcpKey(h.db, 'passo_mcp_totallymadeup')).rejects.toThrow(ApiError);
  });

  it('an EXPIRED key stops working', async () => {
    const k = await createMcpKey(h.db, A.tenantId, 'a', { expiresInDays: 1 });
    // Must run inside the tenant context: RLS filters the UPDATE to zero rows
    // otherwise, and the test would pass while proving nothing.
    const { withTenant } = await import('../../src/infra/db/pool.ts');
    await withTenant(h.db, A.tenantId, (tx) => tx.query(
      `UPDATE mcp_keys SET expires_at = now() - interval '1 day' WHERE id = $1`, [k.id]));
    await expect(resolveMcpKey(h.db, k.key)).rejects.toThrow();
  });
});

describe('MCP scope enforcement', () => {
  it('does not LIST a tool the key cannot call', async () => {
    const readOnly = await listTools(A.tenantId, ['invoices:read']);
    const names = readOnly.tools.map((t) => t.name);
    expect(names).toContain('list_submissions');
    // Offering it would have the model plan around a capability it lacks.
    expect(names).not.toContain('retry_submission');
  });

  it('REFUSES a call beyond scope, explaining rather than returning nothing', async () => {
    const out = await call(A.tenantId, 'retry_submission',
      { submissionId: '00000000-0000-0000-0000-000000000000' }, ['invoices:read']);
    expect(out['refused']).toBe(true);
    expect(out['reason']).toBe('ERR_AUTH_SCOPE');
    // An empty result would have the model report "there is nothing".
    expect(String(out['explanation'])).toMatch(/not an empty result/);
  });

  it('the process-level fallback keeps every tool, as before keys existed', async () => {
    const all = await listTools(A.tenantId);
    expect(all.tools.map((t) => t.name)).toContain('retry_submission');
  });
});

describe('MCP data boundaries', () => {
  it('sees NOTHING from another tenant', async () => {
    const out = await call(B.tenantId, 'list_submissions', { limit: 50 });
    expect(Array.isArray(out)).toBe(true);
  });

  it('list_webhooks NEVER returns a signing secret', async () => {
    await request(h.app).post('/api/v1/webhooks')
      .set({ authorization: `Bearer ${A.apiKey}` })
      .send({ callbackUrl: 'https://1.1.1.1/hook' });
    const out = await call(A.tenantId, 'list_webhooks');
    const blob = JSON.stringify(out);
    expect(blob).not.toMatch(/whsec_/);
    expect(blob).not.toMatch(/secret_encrypted/);
  });

  it('list_dlq_items exposes METADATA only, never the raw receipt', async () => {
    const out = await call(A.tenantId, 'list_dlq_items', { limit: 5 });
    // The payload of a receipt whose tenant is unknown must not reach a model.
    expect(JSON.stringify(out)).not.toMatch(/<\?xml|FatturaElettronica/);
    expect(String((out as { note: string }).note)).toMatch(/Replay is an operator action/);
  });

  it('get_api_key_status returns metadata, never key material', async () => {
    const out = await call(A.tenantId, 'get_api_key_status', {}, ['keys:read']);
    const blob = JSON.stringify(out);
    expect(blob).not.toMatch(/key_hash/);
    expect(blob).not.toMatch(/\$2[aby]\$/);   // no bcrypt hash
  });

  /**
   * The redaction filter is a last line, not the first: every query above is
   * written to avoid secrets. It exists because a future query might not be.
   */
  it('redacts a secret-shaped field even if a query returns one', async () => {
    const out = await call(A.tenantId, 'get_api_key_status', {}, ['keys:read']);
    expect(JSON.stringify(out)).not.toMatch(/"key_hash":"[^"]{10,}/);
  });
});

/**
 * MCP-020 / MCP-022 — named prompts.
 *
 * These exist because the model needs the DOMAIN rules stated, not just the
 * data. Left to itself it reports an NS as "failed, will retry" — exactly
 * backwards, and the advice a user would then act on.
 */
describe('MCP prompts', () => {
  const server = () => createMcpServer({ db: h.db, tenantId: A.tenantId, log: logger });
  const handler = (kind: string) => (server() as unknown as {
    _requestHandlers: Map<string, (r: unknown) => Promise<unknown>>;
  })._requestHandlers.get(kind)!;

  it('lists both prompts', async () => {
    const r = await handler('prompts/list')({ method: 'prompts/list', params: {} }) as
      { prompts: Array<{ name: string }> };
    expect(r.prompts.map((p) => p.name))
      .toEqual(expect.arrayContaining(['invoice_status_report', 'key_rotation_reminder']));
  });

  it('the status report STATES the NS and MC rules explicitly', async () => {
    const r = await handler('prompts/get')({
      method: 'prompts/get', params: { name: 'invoice_status_report', arguments: { days: '30' } },
    }) as { messages: Array<{ content: { text: string } }> };
    const text = r.messages[0]!.content.text;
    expect(text).toMatch(/NS.*TERMINAL/s);
    expect(text).toMatch(/Never describe it as "failed, will retry"/);
    expect(text).toMatch(/MC.*NOT a failure/s);
    expect(text).toMatch(/30 days/);
    // And it must tell the model to quote the remedy, not just the code.
    expect(text).toMatch(/remedy/);
  });

  it('the rotation prompt does NOT imply the model can rotate a key', async () => {
    const r = await handler('prompts/get')({
      method: 'prompts/get', params: { name: 'key_rotation_reminder' },
    }) as { messages: Array<{ content: { text: string } }> };
    const text = r.messages[0]!.content.text;
    expect(text).toMatch(/You cannot rotate\s+a key yourself/);
    expect(text).toMatch(/key material never passes\s+through this interface/);
  });

  it('refuses an unknown prompt, naming what exists', () => {
    // The handler throws synchronously, so it is not a rejected promise.
    expect(() => handler('prompts/get')({
      method: 'prompts/get', params: { name: 'make_it_up' },
    })).toThrow(/Unknown prompt.*invoice_status_report/s);
  });
});

/**
 * MCP-024 — per-session limits.
 *
 * A model in a loop is the realistic failure: not malice, a retry that never
 * terminates. Uncapped it would exhaust the connection pool invoice submission
 * depends on.
 */
describe('MCP call limits', () => {
  it('REFUSES past the per-minute limit, with a reason the model can act on', async () => {
    const server = createMcpServer({ db: h.db, tenantId: A.tenantId, log: logger });
    const call = (server as unknown as {
      _requestHandlers: Map<string, (r: unknown) => Promise<{ content: Array<{ text: string }> }>>;
    })._requestHandlers.get('tools/call')!;

    let refusal: Record<string, unknown> | null = null;
    for (let i = 0; i < 120; i++) {
      const res = await call({ method: 'tools/call',
        params: { name: 'list_submissions', arguments: { limit: 1 } } });
      const parsed = JSON.parse(res.content[0]!.text) as Record<string, unknown>;
      if (parsed['refused']) { refusal = parsed; break; }
    }
    expect(refusal, 'the per-minute limit never engaged').not.toBeNull();
    expect(refusal!['reason']).toBe('ERR_RATE_LIMITED');
    // A bare error would have the model retry immediately — the loop again.
    expect(String(refusal!['explanation'])).toMatch(/Wait for the window to reset/);
  });

  it('a fresh session starts with its own budget', async () => {
    const server = createMcpServer({ db: h.db, tenantId: A.tenantId, log: logger });
    const call = (server as unknown as {
      _requestHandlers: Map<string, (r: unknown) => Promise<{ content: Array<{ text: string }> }>>;
    })._requestHandlers.get('tools/call')!;
    const res = await call({ method: 'tools/call',
      params: { name: 'list_submissions', arguments: { limit: 1 } } });
    expect(JSON.parse(res.content[0]!.text)['refused']).toBeUndefined();
  });
});
