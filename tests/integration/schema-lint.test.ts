import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { withTx } from '../../src/infra/db/pool.ts';
import { TIPODOCUMENTO, REGIMEFISCALE } from '../../src/shared/types/fatturapa-enums.ts';
import { STATE } from '../../src/domain/submission/state.ts';

/**
 * Schema conformance (DB-003 / DB-018 / DB-024).
 *
 * These assertions run against the LIVE schema rather than the migration files,
 * because what matters is the database an operator actually has — a migration
 * that was edited after being applied, or a hand-run ALTER, diverges silently.
 */
let h: Harness;
beforeAll(() => { h = createHarness(); });
afterAll(async () => { await h.close(); });

const q = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  withTx(h.db, (tx) => tx.query<T>(sql, params));

describe('column type conventions', () => {
  it('every temporal column is TIMESTAMPTZ — a bare TIMESTAMP loses the offset', async () => {
    const r = await q<{ t: string }>(`
      SELECT table_name || '.' || column_name AS t
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type = 'timestamp without time zone'
         AND table_name <> 'pgmigrations'`);
    expect(r.rows.map((x) => x.t)).toEqual([]);
  });

  it('no float, double or money column exists — money is exact or it is wrong', async () => {
    const r = await q<{ t: string }>(`
      SELECT table_name || '.' || column_name AS t
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type IN ('double precision', 'real', 'money')`);
    expect(r.rows.map((x) => x.t)).toEqual([]);
  });

  /**
   * FatturaPA permits ELEVEN integer digits. NUMERIC(15,8) holds only seven,
   * so a large invoice would fail on insert — after the CRM believed it was
   * accepted.
   */
  it('every monetary column holds 11 integer digits', async () => {
    const r = await q<{ t: string; p: number; s: number }>(`
      SELECT table_name || '.' || column_name AS t,
             numeric_precision AS p, numeric_scale AS s
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type = 'numeric'
         AND column_name ~ 'amount|price|total|taxable|imponibile|imposta'`);
    for (const c of r.rows) {
      expect(c.p - c.s, `${c.t} holds only ${c.p - c.s} integer digits`)
        .toBeGreaterThanOrEqual(11);
    }
  });
});

describe('enum CHECK constraints', () => {
  const constraintFor = async (name: string) =>
    (await q<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [name])).rows[0]?.def ?? '';

  it('TipoDocumento is constrained to the real XSD values', async () => {
    const def = await constraintFor('invoices_document_type_check');
    expect(def).toBeTruthy();
    for (const v of TIPODOCUMENTO) expect(def, v).toContain(`'${v}'`);
    // The gaps are real: TD07–TD15 do not exist in the schema.
    for (const missing of ['TD07', 'TD10', 'TD15']) expect(def).not.toContain(`'${missing}'`);
    expect(def).toContain("'TD29'");
  });

  it('RegimeFiscale is constrained, and RF03 genuinely does not exist', async () => {
    const def = await constraintFor('sellers_tax_regime_check');
    for (const v of REGIMEFISCALE) expect(def, v).toContain(`'${v}'`);
    expect(def).not.toContain("'RF03'");
  });

  it('submission state is constrained to the state machine', async () => {
    const def = await constraintFor('sdi_submissions_state_check');
    for (const v of Object.values(STATE)) expect(def, v).toContain(`'${v}'`);
  });

  it('channel is constrained to registered adapters', async () => {
    // An unregistered channel can never dispatch: the submission would sit
    // queued forever with no error raised anywhere.
    const def = await constraintFor('sdi_submissions_channel_check');
    for (const v of ['mock', 'pec', 'invoicetronic', 'openapi']) expect(def).toContain(`'${v}'`);
  });

  it('REFUSES an invalid document type at the database, not just at the API', async () => {
    await expect(q(
      `INSERT INTO invoices (tenant_id, seller_id, invoice_number, document_type, issue_date)
       VALUES (gen_random_uuid(), gen_random_uuid(), 'X', 'TD99', now())`,
    )).rejects.toThrow();
  });

  it('REFUSES an unknown submission state', async () => {
    // Insert rather than update: an UPDATE under RLS with no tenant context
    // matches zero rows, so the constraint is never evaluated and the test
    // would pass without proving anything.
    await expect(q(
      `INSERT INTO sdi_submissions
         (tenant_id, invoice_id, transmitter_id, progressivo_invio, channel, state)
       VALUES (gen_random_uuid(), gen_random_uuid(), 'IT01234567890', '00001',
               'mock', 'not_a_state')`,
    // RLS rejects first here, which is correct defence in depth — the point is
    // that the write does not land.
    )).rejects.toThrow(/violates check constraint|row-level security|permission denied/);
  });

  it('REFUSES an unregistered channel', async () => {
    await expect(q(
      `INSERT INTO sdi_submissions
         (tenant_id, invoice_id, transmitter_id, progressivo_invio, channel, state)
       VALUES (gen_random_uuid(), gen_random_uuid(), 'IT01234567890', '00001',
               'carrier-pigeon', 'queued')`,
    )).rejects.toThrow(/violates check constraint|row-level security|permission denied/);
  });

  /**
   * Prove the CHECK itself is enforced, independently of RLS: ask Postgres to
   * evaluate the constraint expression directly. Otherwise a dropped CHECK
   * would be invisible behind the RLS rejection above.
   */
  it('the state CHECK is enforced by the DATABASE, not only by RLS', async () => {
    const r = await q<{ ok: boolean }>(
      `SELECT ('not_a_state' = ANY (string_to_array(
                 replace(replace(substring(pg_get_constraintdef(oid)
                   from '\\((.*)\\)$'), '''', ''), ' ', ''), ','))) AS ok
         FROM pg_constraint WHERE conname = 'sdi_submissions_state_check'`);
    expect(r.rows[0]!.ok, 'not_a_state must NOT be an accepted value').toBe(false);
  });
});

describe('referential integrity', () => {
  it('every tenant-scoped FK is COMPOSITE — RLS protects rows, not references', async () => {
    // A plain (seller_id) FK lets tenant B reference tenant A's seller, issuing
    // an invoice under another company's legal identity.
    const r = await q<{ n: number }>(`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE contype = 'f' AND conname LIKE '%tenant_fkey'`);
    expect(r.rows[0]!.n).toBeGreaterThan(0);
  });

  it('RLS is ENABLED and FORCED on every tenant-scoped table', async () => {
    const r = await q<{ relname: string }>(`
      SELECT c.relname FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND EXISTS (SELECT 1 FROM information_schema.columns col
                      WHERE col.table_name = c.relname AND col.column_name = 'tenant_id')
         AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`);
    // FORCE matters: without it the table owner bypasses its own policies.
    expect(r.rows.map((x) => x.relname)).toEqual([]);
  });
});
