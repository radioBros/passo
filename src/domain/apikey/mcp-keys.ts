import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import bcrypt from 'bcrypt';
import type { Db } from '../../infra/db/pool.ts';
import { withTenant, withTx, audit } from '../../infra/db/pool.ts';
import { assertValidScopes, MCP_DEFAULT_SCOPES, type Scope } from './scopes.ts';
import { ApiError } from '../../shared/errors/catalog.ts';

/**
 * MCP key lifecycle (MCP-005 / MCP-006 / MCP-027).
 *
 * Before this, MCP isolation came from `PASSO_MCP_TENANT_ID` at process start:
 * real isolation, but the *authority* was "can start the container" rather than
 * a credential. That works for a self-hosted operator running the server
 * themselves and not at all for anything else — it cannot be revoked, cannot be
 * scoped per assistant, and leaves no trail of which key did what.
 *
 * A key is `passo_mcp_` + 32 random bytes, stored as a bcrypt hash. It is shown
 * once. The prefix is kept in clear so a key can be identified in a listing
 * without holding the secret.
 *
 * Defaults are narrower than an API key's: the holder is a language model, so
 * it may read and it may retry a submission — a bounded action the state
 * machine already refuses when unsafe — but it may not mint credentials or
 * redirect a webhook.
 */

const PREFIX = 'passo_mcp_';
const BCRYPT_ROUNDS = 12;

export interface McpKeyRecord {
  id: string; tenantId: string; name: string; scopes: Scope[];
}

/** A lookup handle that avoids bcrypt-ing every row on every call. */
const lookupHash = (key: string): string =>
  createHash('sha256').update(key).digest('hex').slice(0, 32);

export interface CreatedMcpKey {
  id: string; key: string; name: string; scopes: Scope[]; expiresAt: string | null;
}

export async function createMcpKey(
  db: Db, tenantId: string, name: string,
  opts: { scopes?: string[]; expiresInDays?: number } = {},
): Promise<CreatedMcpKey> {
  const scopes = opts.scopes ? assertValidScopes(opts.scopes) : [...MCP_DEFAULT_SCOPES];
  const key = `${PREFIX}${randomBytes(32).toString('base64url')}`;
  const hash = await bcrypt.hash(key, BCRYPT_ROUNDS);
  const expiresAt = opts.expiresInDays
    ? new Date(Date.now() + opts.expiresInDays * 86_400_000).toISOString()
    : null;

  const row = await withTenant(db, tenantId, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO mcp_keys (tenant_id, key_hash, key_lookup, key_prefix, name, scopes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [tenantId, hash, lookupHash(key), key.slice(0, 18), name, scopes, expiresAt]);
    await audit(tx, {
      tenantId, actor: 'admin', action: 'mcp_key.create',
      resourceType: 'mcp_key', resourceId: r.rows[0]!.id, detail: { name, scopes },
    });
    return r.rows[0]!;
  });

  // Shown ONCE. Nothing retrieves it afterwards.
  return { id: row.id, key, name, scopes, expiresAt };
}

/**
 * Resolve a presented key to its tenant.
 *
 * Runs under `passo_auth` because resolving the key IS how the tenant becomes
 * known — there is no tenant context to set beforehand. The lookup column
 * narrows the candidate set so bcrypt runs once rather than per row.
 */
export async function resolveMcpKey(db: Db, presented: string): Promise<McpKeyRecord> {
  if (!presented.startsWith(PREFIX)) throw new ApiError('ERR_AUTH_INVALID');

  const rows = await withTx(db, async (tx) => {
    await tx.query('SET LOCAL ROLE passo_auth');
    return tx.query<{
      id: string; tenant_id: string; key_hash: string; name: string;
      scopes: string[]; status: string; expires_at: Date | null;
    }>(
      `SELECT id, tenant_id, key_hash, name, scopes, status, expires_at
         FROM mcp_key_auth WHERE key_lookup = $1`, [lookupHash(presented)]);
  });

  for (const row of rows.rows) {
    if (!(await bcrypt.compare(presented, row.key_hash))) continue;
    if (row.status === 'revoked') throw new ApiError('ERR_AUTH_REVOKED');
    if (row.expires_at && row.expires_at.getTime() < Date.now()) {
      throw new ApiError('ERR_AUTH_EXPIRED');
    }
    return {
      id: row.id, tenantId: row.tenant_id, name: row.name,
      scopes: row.scopes as Scope[],
    };
  }
  // Indistinguishable from a malformed key: a different error would confirm
  // that a well-formed key exists somewhere.
  throw new ApiError('ERR_AUTH_INVALID');
}

export async function listMcpKeys(db: Db, tenantId: string): Promise<unknown[]> {
  const r = await withTenant(db, tenantId, (tx) => tx.query(
    `SELECT id, key_prefix, name, scopes, status, expires_at, last_used_at, created_at
       FROM mcp_keys ORDER BY created_at DESC`));
  return r.rows;   // key_hash is never selected
}

export async function revokeMcpKey(db: Db, tenantId: string, id: string): Promise<void> {
  const n = await withTenant(db, tenantId, async (tx) => {
    const r = await tx.query(
      `UPDATE mcp_keys SET status = 'revoked' WHERE id = $1 AND status <> 'revoked'
       RETURNING id`, [id]);
    if (r.rows[0]) {
      await audit(tx, {
        tenantId, actor: 'admin', action: 'mcp_key.revoke',
        resourceType: 'mcp_key', resourceId: id,
      });
    }
    return r.rowCount ?? 0;
  });
  if (n === 0) throw new ApiError('ERR_NOT_FOUND', 'mcp key');
}

/** Rotate: a new secret, the old one revoked immediately. */
export async function rotateMcpKey(
  db: Db, tenantId: string, id: string,
): Promise<CreatedMcpKey> {
  const existing = await withTenant(db, tenantId, (tx) => tx.query<{
    name: string; scopes: string[];
  }>('SELECT name, scopes FROM mcp_keys WHERE id = $1', [id]));
  const row = existing.rows[0];
  if (!row) throw new ApiError('ERR_NOT_FOUND', 'mcp key');

  const created = await createMcpKey(db, tenantId, row.name, { scopes: row.scopes });
  await revokeMcpKey(db, tenantId, id);
  return created;
}

/** Constant-time compare, exported for the auth path's own use. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
