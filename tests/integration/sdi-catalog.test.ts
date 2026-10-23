import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { withTx } from '../../src/infra/db/pool.ts';
import { SDI_ERRORS, SDI_ERROR_COUNT } from '../../src/shared/errors/sdi-errors.ts';

/**
 * NOTIF-014 — the catalogue as seeded reference data.
 *
 * It exists twice: as a TypeScript module the running code reads, and as a
 * table an operator can query without booting the app. Two copies of the same
 * facts drift, and a drifted catalogue attaches the wrong description to a real
 * rejection — sending an integrator to the wrong field. These tests are the
 * only thing keeping the copies honest.
 */
let h: Harness;
beforeAll(() => { h = createHarness(); });
afterAll(async () => { await h.close(); });

const table = () => withTx(h.db, (tx) => tx.query<{
  code: string; description_it: string; gloss_en: string; remedy: string; source: string;
}>('SELECT code, description_it, gloss_en, remedy, source FROM sdi_error_catalog ORDER BY code'));

describe('sdi_error_catalog', () => {
  it('is seeded by migration with every code', async () => {
    expect((await table()).rows).toHaveLength(SDI_ERROR_COUNT);
  });

  it('is NOT tenant-scoped — it is reference data, readable without a tenant', async () => {
    // withTx sets no app.tenant_id; RLS-scoped tables return zero rows here.
    expect((await table()).rows.length).toBeGreaterThan(0);
  });

  it('agrees with the TypeScript module, code for code', async () => {
    for (const row of (await table()).rows) {
      const mod = SDI_ERRORS[row.code];
      expect(mod, row.code).toBeDefined();
      expect(row.description_it, row.code).toBe(mod!.description);
      expect(row.gloss_en, row.code).toBe(mod!.gloss);
      expect(row.remedy, row.code).toBe(mod!.remedy);
    }
  });

  it('records its source, so completeness is auditable', async () => {
    for (const row of (await table()).rows) {
      expect(row.source).toMatch(/Elenco dei controlli v2\.0/);
    }
  });

  it('carries an English gloss for every code', async () => {
    for (const row of (await table()).rows) {
      expect(row.gloss_en.length, row.code).toBeGreaterThan(4);
    }
  });

  it('is read-only to the application role', async () => {
    await expect(withTx(h.db, (tx) => tx.query(
      "INSERT INTO sdi_error_catalog (code, description_it, gloss_en, remedy, source) " +
      "VALUES ('09998','x','x','fix_payload','test')",
    ))).rejects.toThrow(/permission denied/i);
  });
});
