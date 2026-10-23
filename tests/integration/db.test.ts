import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createPool, withTenant, withTx, audit, verifyAuditChain, routeNotification, withQuarantineRole } from '../../src/infra/db/pool.ts';

import { createHarness, seedTenant, type Harness } from '../helpers/harness.ts';

// These tests seed their OWN tenants rather than assuming fixture UUIDs: the
// database is rebuilt whenever the stack is recreated, so hardcoded ids break.
let h: Harness;
let db: ReturnType<typeof createPool>;
let A = '';
let B = '';

beforeAll(async () => {
  h = createHarness();
  db = h.db;
  A = (await seedTenant(h)).tenantId;
  B = (await seedTenant(h)).tenantId;
});
afterAll(async () => { await h.close(); });

describe('tenant isolation via RLS', () => {
  it('tenant A cannot see tenant B rows', async () => {
    const a = await withTenant(db, A, (tx) => tx.query('SELECT count(*)::int AS n FROM sellers'));
    const b = await withTenant(db, B, (tx) => tx.query('SELECT count(*)::int AS n FROM sellers'));
    expect(a.rows[0].n).toBe(1);   // its own seller only
    expect(b.rows[0].n).toBe(1);
  });

  it('no tenant context returns ZERO rows, never an exception', async () => {
    const r = await withTx(db, (tx) => tx.query('SELECT count(*)::int AS n FROM sellers'));
    expect(r.rows[0].n).toBe(0);
  });

  it('WITH CHECK blocks writing a foreign tenant_id', async () => {
    await expect(withTenant(db, A, (tx) => tx.query(
      `INSERT INTO sellers (tenant_id,tax_regime,denomination,address)
       VALUES ($1,'RF01','EVIL','{}')`, [B],
    ))).rejects.toThrow(/row-level security/);
  });
});

describe('hash-chained audit log', () => {
  // The deletion test below permanently breaks the chain, so each test starts
  // from a clean slate rather than depending on execution order.
  beforeEach(async () => {
    await withTenant(db, A, (tx) => tx.query('DELETE FROM audit_log WHERE tenant_id = $1', [A]));
  });

  it('appends and verifies', async () => {
    await withTenant(db, A, (tx) => audit(tx, { tenantId: A, actor: 'test', action: 'invoice.submit' }));
    await withTenant(db, A, (tx) => audit(tx, { tenantId: A, actor: 'test', action: 'invoice.transmit' }));
    expect((await verifyAuditChain(db, A)).ok).toBe(true);
  });

  it('detects a DELETED row — a per-row hash could not', async () => {
    await withTenant(db, A, (tx) => audit(tx, { tenantId: A, actor: 't', action: 'a' }));
    await withTenant(db, A, (tx) => audit(tx, { tenantId: A, actor: 't', action: 'b' }));
    await withTenant(db, A, (tx) => audit(tx, { tenantId: A, actor: 't', action: 'c' }));
    // audit_log is tenant-scoped, so reads/writes need the RLS context.
    const victim = await withTenant(db, A, async (tx) => {
      const r = await tx.query<{ id: string }>('SELECT id FROM audit_log ORDER BY id DESC LIMIT 2');
      return r.rows[1]!.id;                             // a middle row
    });
    await withTenant(db, A, (tx) => tx.query('DELETE FROM audit_log WHERE id = $1', [victim]));
    const v = await verifyAuditChain(db, A);
    expect(v.ok).toBe(false);
    expect(v.brokenAtId).toBeDefined();
  });
});

describe('late-receipt routing (the one sanctioned RLS bypass)', () => {
  it('resolves a tenant from IdentificativoSdI with no tenant context', async () => {
    const sdiId = `route-${Date.now()}`;
    await withTenant(db, A, (tx) => tx.query(
      `INSERT INTO correlation_records
         (tenant_id, submission_id, progressivo_invio, transmitter_id, identificativo_sdi, status)
       VALUES ($1, gen_random_uuid(), '00001', 'IT01234567890', $2, 'transmitted')`,
      [A, sdiId]));
    const hit = await routeNotification(db, { identificativoSdI: sdiId });
    expect(hit?.tenantId).toBe(A);
    expect(hit?.status).toBe('transmitted');
  });
  it('returns null for an unknown identifier (caller must quarantine)', async () => {
    expect(await routeNotification(db, { identificativoSdI: 'nope' })).toBeNull();
  });
});

/**
 * SEC-037 — a quarantined receipt has no determinable tenant, so RLS cannot
 * scope it. Containment comes from GRANTs instead, and these tests are the only
 * thing standing between that design and a silent cross-tenant leak: the blanket
 * `GRANT ... ON ALL TABLES` in provisioning would otherwise quietly restore the
 * read.
 */
describe('quarantine containment', () => {
  it('the tenant-scoped role CANNOT read a quarantined payload', async () => {
    await expect(
      withTenant(db, A, (tx) => tx.query('SELECT raw FROM quarantined_notifications LIMIT 1')),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the tenant-scoped role can still INSERT — ingest must keep working', async () => {
    await expect(withTx(db, (tx) => tx.query(
      `INSERT INTO quarantined_notifications (reason,type,identificativo_sdi,raw,channel)
       VALUES ('test','RC','contain-probe','<x/>','mock')`,
    ))).resolves.toBeTruthy();
  });

  it('the dedicated role CAN read it, for the operator surfaces', async () => {
    const r = await withQuarantineRole(db, (tx) =>
      tx.query<{ n: number }>('SELECT count(*)::int AS n FROM quarantined_notifications'));
    expect(r.rows[0]!.n).toBeGreaterThan(0);
  });

  /**
   * Postgres 16 tracks inheritance per MEMBERSHIP (`pg_auth_members.
   * inherit_option`), and `ALTER ROLE ... NOINHERIT` does not change existing
   * grants. Without `WITH INHERIT FALSE` every bypass role is held ambiently and
   * `SET LOCAL ROLE` becomes decorative.
   */
  it('NO bypass role is ambiently inherited — each must be assumed', async () => {
    const r = await withTx(db, (tx) => tx.query<{ rolname: string; inherit_option: boolean }>(
      `SELECT m.rolname, am.inherit_option
         FROM pg_auth_members am
         JOIN pg_roles r ON r.oid = am.member
         JOIN pg_roles m ON m.oid = am.roleid
        WHERE r.rolname = 'passo_app'`));
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) expect(row.inherit_option, row.rolname).toBe(false);
  });
});
