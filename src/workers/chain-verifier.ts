import type { Db } from '../infra/db/pool.ts';
import { withTx, verifyAuditChain } from '../infra/db/pool.ts';
import type { Logger } from '../shared/logger.ts';
import { alert } from '../domain/alert/service.ts';

/**
 * Periodic audit-chain verification (SEC-025).
 *
 * The hash chain makes tampering *detectable*; it does not make it *detected*.
 * Without something checking on a schedule, a deleted or altered row is only
 * found when someone thinks to look — which, in practice, is during the
 * investigation the tampering was meant to defeat.
 *
 * Running it per tenant means one broken chain is isolated and named rather
 * than collapsing into a single global "something is wrong".
 *
 * ⚠️ Scope: `audit_log` is tenant-scoped while the chain is global, so a
 * per-tenant verification proves that tenant's entries form an unbroken
 * *subsequence*. It catches edits, deletions and reordering within a tenant.
 * It cannot, by itself, prove no rows were removed across tenants — that needs
 * the cross-tenant read the checkpoint anchors are for.
 */

export interface ChainReport {
  checked: number;
  broken: Array<{ tenantId: string; at: string | null }>;
}

export async function verifyAllChains(db: Db, log: Logger): Promise<ChainReport> {
  const report: ChainReport = { checked: 0, broken: [] };

  // Enumerating tenants happens before any tenant is known, so it cannot run
  // under a tenant context; `tenants` carries no RLS for exactly this reason.
  const tenants = await withTx(db, (tx) =>
    tx.query<{ id: string }>(`SELECT id FROM tenants WHERE status <> 'deactivated'`));

  for (const { id } of tenants.rows) {
    report.checked++;
    try {
      const v = await verifyAuditChain(db, id);
      if (!v.ok) {
        const at = v.brokenAtId ?? null;
        report.broken.push({ tenantId: id, at });
        log.error(
          { tenantId: id, brokenAt: at },
          'AUDIT CHAIN BROKEN — an audit entry has been deleted, reordered or edited. ' +
          'This is tamper evidence, not a bug: preserve the database and investigate ' +
          'before writing anything further.',
        );
        await alert({ tenantId: null, kind: 'system.audit_chain_broken', channel: null,
          detail: { tenantId: id, brokenAtId: at } });
      }
    } catch (err) {
      // A verification that cannot run is itself a finding: silence here would
      // be indistinguishable from a clean result.
      log.error({ err, tenantId: id }, 'audit chain verification FAILED to run');
      report.broken.push({ tenantId: id, at: null });
    }
  }

  if (report.broken.length === 0) {
    log.info({ tenants: report.checked }, 'audit chains verified intact');
  }
  return report;
}

/** Run verification on an interval. Daily by default. */
export function startChainVerifier(
  db: Db, log: Logger, intervalMs = 24 * 3_600_000,
): { stop: () => void } {
  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      await verifyAllChains(db, log);
    } catch (err) {
      log.error({ err }, 'chain verifier tick failed');
    }
    if (!stopped) setTimeout(() => void tick(), intervalMs).unref();
  };
  // Deliberately not on boot: a restart loop would otherwise re-verify every
  // chain on every crash, which is expensive and drowns the signal.
  setTimeout(() => void tick(), intervalMs).unref();
  return { stop: () => { stopped = true; } };
}
