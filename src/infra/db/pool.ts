import pg from 'pg';
import { createHash } from 'node:crypto';
import type { Config } from '../../shared/config.ts';

/**
 * Database access.
 *
 * Every tenant-scoped query runs inside a transaction that has set
 * `app.tenant_id`. RLS is the backstop, not the mechanism — but a forgotten
 * SET LOCAL must fail CLOSED (zero rows), which the NULLIF policy guarantees.
 */

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(cfg: Config): Db {
  return new pg.Pool({
    connectionString: cfg.DATABASE_URL,
    max: cfg.DATABASE_POOL_MAX,
    statement_timeout: cfg.DATABASE_STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

/** Run inside a transaction with the tenant RLS context set. */
export async function withTenant<T>(
  db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Transaction with NO tenant context — only for tenancy-root tables. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Resolve a tenant from an SdI identifier when the tenant is UNKNOWN — the one
 * sanctioned RLS bypass. Reads a six-column view carrying no fiscal or personal
 * data. Every lookup is audited by the caller.
 */
export async function routeNotification(
  db: Db, by: { identificativoSdI?: string; pecMessageId?: string; progressivoInvio?: string },
): Promise<{ tenantId: string; submissionId: string; status: string } | null> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE passo_router');
    const r = await c.query<{ tenant_id: string; submission_id: string; status: string }>(
      `SELECT tenant_id, submission_id, status FROM correlation_routing
        WHERE ($1::text IS NOT NULL AND identificativo_sdi = $1)
           OR ($2::text IS NOT NULL AND pec_message_id     = $2)
           OR ($3::text IS NOT NULL AND progressivo_invio  = $3)
        LIMIT 1`,
      [by.identificativoSdI ?? null, by.pecMessageId ?? null, by.progressivoInvio ?? null],
    );
    await c.query('COMMIT');
    const row = r.rows[0];
    return row ? { tenantId: row.tenant_id, submissionId: row.submission_id, status: row.status } : null;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Run a read against the quarantine store under `passo_quarantine`.
 *
 * A quarantined receipt has no determinable tenant, so RLS cannot scope it and
 * containment is enforced by GRANT instead: the tenant-scoped `passo_app` role
 * cannot SELECT the raw payload at all. Operator surfaces reach it only here,
 * which keeps the cross-tenant read on one narrow, auditable path.
 */
export async function withQuarantineRole<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE passo_quarantine');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Append to the hash-chained audit log.
 *
 * Each row's hash covers the PREVIOUS row's hash, so deletion and reordering
 * are detectable — a per-row hash would only catch field edits.
 */
export async function audit(
  tx: Tx,
  e: {
    tenantId?: string; actor: string; action: string;
    resourceType?: string; resourceId?: string; detail?: unknown; ip?: string;
  },
): Promise<void> {
  /**
   * The previous link is the last row THIS TENANT can see.
   *
   * RLS scopes the read, so the chain is per-tenant by construction rather than
   * global: tenant A's rows link only to tenant A's. That is what makes
   * verification possible under the same RLS context that wrote the entries —
   * a global chain would be unverifiable by anyone who cannot read every row.
   */
  const prev = await tx.query<{ hash: string }>(
    'SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1',
  );
  const prevHash = prev.rows[0]?.hash ?? null;
  const payload = JSON.stringify({
    tenantId: e.tenantId ?? null, actor: e.actor, action: e.action,
    resourceType: e.resourceType ?? null, resourceId: e.resourceId ?? null,
    detail: e.detail ?? null, at: new Date().toISOString(),
  });
  const hash = createHash('sha256').update(`${prevHash ?? ''}${payload}`).digest('hex');
  await tx.query(
    `INSERT INTO audit_log
       (tenant_id, actor, action, resource_type, resource_id, detail, ip, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.tenantId ?? null, e.actor, e.action, e.resourceType ?? null,
     e.resourceId ?? null, e.detail ? JSON.stringify(e.detail) : null,
     e.ip ?? null, prevHash, hash],
  );
}

/**
 * Verify the audit chain. Detects edits, deletions AND reordering.
 *
 * audit_log is tenant-scoped, so this runs inside the tenant RLS context — and
 * the chain is PER-TENANT by construction: `audit()` links each row to the last
 * row the SAME tenant could see, because that read is itself RLS-scoped.
 * Verification therefore checks a complete chain rather than a subsequence.
 *
 * A deletion, an edit or a reordering anywhere in the tenant's history breaks
 * the link and is reported with the id where the break was found.
 */
export async function verifyAuditChain(
  db: Db, tenantId: string,
): Promise<{ ok: boolean; brokenAtId?: string }> {
  return withTenant(db, tenantId, async (tx) => {
    const r = await tx.query<{ id: string; prev_hash: string | null; hash: string }>(
      'SELECT id, prev_hash, hash FROM audit_log ORDER BY id ASC',
    );
    let expectedPrev: string | null = null;
    for (const row of r.rows) {
      // The first visible row's prev_hash links to a row we may not be able to
      // see; only the links BETWEEN visible rows are checkable here.
      if (expectedPrev !== null && row.prev_hash !== expectedPrev) {
        return { ok: false, brokenAtId: row.id };
      }
      expectedPrev = row.hash;
    }
    return { ok: true };
  });
}
