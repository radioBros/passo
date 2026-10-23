import bcrypt from 'bcrypt';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { assertValidScopes, DEFAULT_SCOPES } from './scopes.ts';
import type { Db } from '../../infra/db/pool.ts';
import { withTenant, audit } from '../../infra/db/pool.ts';
import { ApiError } from '../../shared/errors/catalog.ts';

/**
 * API keys are per tenant. The plaintext is shown ONCE at creation and never
 * stored — only a bcrypt hash.
 *
 * Rotation keeps the old key valid for a grace window so an integration can
 * roll over without downtime. Revocation is immediate, no grace.
 */
const ROUNDS = 12;
const GRACE_DAYS = 7;

export interface CreatedKey { id: string; key: string; prefix: string; expiresAt: Date | null }

export function generateKey(env: 'live' | 'test' = 'live'): { key: string; prefix: string } {
  const body = randomBytes(24).toString('base64url');
  const key = `passo_${env}_${body}`;
  return { key, prefix: key.slice(0, 16) };
}

export async function createApiKey(
  db: Db, tenantId: string, name: string,
  opts: { environment?: 'live' | 'test'; scopes?: string[]; expiresInDays?: number } = {},
): Promise<CreatedKey> {
  const env = opts.environment ?? 'live';
  const { key, prefix } = generateKey(env);
  const hash = await bcrypt.hash(key, ROUNDS);
  const expiresAt = opts.expiresInDays
    ? new Date(Date.now() + opts.expiresInDays * 86_400_000) : null;

  // api_keys is tenant-scoped: writing it needs the RLS context. Using a bare
  // transaction here is what WITH CHECK exists to catch.
  return withTenant(db, tenantId, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, name, environment, scopes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [tenantId, hash, prefix, name, env,
       opts.scopes ? assertValidScopes(opts.scopes) : [...DEFAULT_SCOPES], expiresAt],
    );
    await audit(tx, {
      tenantId, actor: 'admin', action: 'apikey.create',
      resourceType: 'api_key', resourceId: r.rows[0]!.id, detail: { name, environment: env },
    });
    // The plaintext is returned here and never again.
    return { id: r.rows[0]!.id, key, prefix, expiresAt };
  });
}

export interface ResolvedKey {
  id: string; tenantId: string; scopes: string[];
  /** Set when the key is in its post-rotation grace window. */
  graceExpiresAt?: Date;
}

/**
 * Resolve a presented key to its tenant.
 *
 * This lookup runs BEFORE the tenant is known — determining it is the whole
 * point — so it cannot use an app.tenant_id context. It uses the dedicated
 * passo_auth role against a view exposing only the auth columns.
 *
 * Candidates are narrowed by prefix, then compared with bcrypt, which is
 * constant-time internally. The key itself is never string-compared.
 */
export async function resolveApiKey(db: Db, presented: string): Promise<ResolvedKey> {
  if (!presented.startsWith('passo_')) throw new ApiError('ERR_AUTH_INVALID');
  const prefix = presented.slice(0, 16);
  const c = await db.connect();
  let rows: Array<{
    id: string; tenant_id: string; key_hash: string; scopes: string[];
    status: string; expires_at: Date | null; revoked_at: Date | null;
    grace_expires_at: Date | null;
  }>;
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE passo_auth');
    const q = await c.query(
      `SELECT id, tenant_id, key_hash, scopes, status, expires_at, revoked_at,
              grace_expires_at
         FROM api_key_auth WHERE key_prefix = $1`, [prefix],
    );
    rows = q.rows;
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally { c.release(); }

  for (const row of rows) {
    if (!(await bcrypt.compare(presented, row.key_hash))) continue;
    if (row.status === 'revoked' || row.revoked_at) throw new ApiError('ERR_AUTH_REVOKED');
    if (row.expires_at && row.expires_at < new Date()) throw new ApiError('ERR_AUTH_EXPIRED');

    /**
     * A rotated key keeps working until its grace window closes (KEY-010).
     *
     * Without this, rotating is a coordinated outage and operators simply do
     * not rotate. Past the window it stops — a grace period that never ends is
     * a second live credential, not a rotation.
     */
    if (row.status === 'grace') {
      if (row.grace_expires_at && row.grace_expires_at < new Date()) {
        throw new ApiError('ERR_AUTH_EXPIRED');
      }
      void markUsed(db, row.id, true);
      return {
        id: row.id, tenantId: row.tenant_id, scopes: row.scopes,
        ...(row.grace_expires_at ? { graceExpiresAt: row.grace_expires_at } : {}),
      };
    }

    void markUsed(db, row.id);
    return { id: row.id, tenantId: row.tenant_id, scopes: row.scopes };
  }
  throw new ApiError('ERR_AUTH_INVALID');
}

/**
 * Record use. `grace` bumps a counter too, so an operator can see "the old key
 * is still being used, 400 times yesterday" and chase the caller BEFORE the
 * window closes rather than when their traffic stops.
 */
async function markUsed(db: Db, id: string, grace = false): Promise<void> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE passo_auth');
    await c.query(
      grace
        ? 'UPDATE api_keys SET last_used_at = now(), grace_uses = grace_uses + 1 WHERE id = $1'
        : 'UPDATE api_keys SET last_used_at = now() WHERE id = $1', [id]);
    await c.query('COMMIT');
  } catch { await c.query('ROLLBACK').catch(() => undefined); }
  finally { c.release(); }
}

/** Rotate: issue a new key, expire the old one after a grace window. */
export async function rotateApiKey(db: Db, tenantId: string, keyId: string): Promise<CreatedKey> {
  // api_keys is tenant-scoped: a bare db.query has no RLS context, so every row
  // is filtered and an existing key looks like ERR_NOT_FOUND.
  const old = await withTenant(db, tenantId, (tx) =>
    tx.query<{ name: string; environment: 'live' | 'test'; scopes: string[] }>(
      'SELECT name, environment, scopes FROM api_keys WHERE id=$1 AND tenant_id=$2',
      [keyId, tenantId]));
  const o = old.rows[0];
  if (!o) throw new ApiError('ERR_NOT_FOUND', 'api key');
  const created = await createApiKey(db, tenantId, `${o.name} (rotated)`, {
    environment: o.environment, scopes: o.scopes,
  });
  await withTenant(db, tenantId, async (tx) => {
    await tx.query(
      /**
       * `grace`, with its own expiry column (KEY-010).
       *
       * Reusing `expires_at` conflated two different clocks — the key's own
       * lifetime and the rotation window — so a key rotated near its natural
       * expiry had that expiry silently EXTENDED by the rotation.
       */
      `UPDATE api_keys
          SET status = 'grace',
              grace_expires_at = now() + ($2 || ' days')::interval
        WHERE id = $1`, [keyId, String(GRACE_DAYS)],
    );
    await tx.query('UPDATE api_keys SET rotated_from = $1 WHERE id = $2', [keyId, created.id]);
    await audit(tx, {
      tenantId, actor: 'admin', action: 'apikey.rotate',
      resourceType: 'api_key', resourceId: keyId,
      detail: { newKeyId: created.id, graceDays: GRACE_DAYS },
    });
  });
  return created;
}

/** Revoke: immediate, no grace period. */
export async function revokeApiKey(db: Db, tenantId: string, keyId: string): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    const r = await tx.query(
      `UPDATE api_keys SET status='revoked', revoked_at=now() WHERE id=$1 AND tenant_id=$2`,
      [keyId, tenantId],
    );
    if (r.rowCount === 0) throw new ApiError('ERR_NOT_FOUND', 'api key');
    await audit(tx, {
      tenantId, actor: 'admin', action: 'apikey.revoke',
      resourceType: 'api_key', resourceId: keyId,
    });
  });
}

/** Constant-time comparison for the bootstrap admin key from env. */
export function checkAdminKey(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual THROWS on unequal lengths — check length first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
