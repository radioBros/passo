import type { Db } from '../infra/db/pool.ts';
import { withTx, audit } from '../infra/db/pool.ts';
import type { Config } from '../shared/config.ts';
import type { Logger } from '../shared/logger.ts';

/**
 * Purge job — the mechanism behind the stateless-relay guarantee.
 *
 * PASSO keeps no invoice archive. Retention rules:
 *   payload + XML   purged once a TERMINAL receipt has arrived
 *   receipts        purged only once ACKNOWLEDGED, plus a grace window
 *   correlation     kept ~90 days so a late receipt can still be routed
 *   audit           ~12 months, operational forensics — not a tax archive
 *
 * An UNACKNOWLEDGED receipt is never purged, regardless of age. Age alone is
 * never sufficient. The database enforces this too: notifications carries
 * CHECK (purge_eligible_at IS NULL OR acknowledged_at IS NOT NULL).
 */

export interface PurgeStats {
  payloads: number; receipts: number; correlations: number; auditRows: number;
  outboxRows: number; deliveryRows: number; idempotencyRows: number; quarantineRows: number;
  usageRows: number;
}

export async function runPurge(
  db: Db, cfg: Config, log: Logger,
  /**
   * Restrict the purge to ONE tenant.
   *
   * Production never passes this — the purge worker serves every tenant. It
   * exists so a test can exercise the purge without destroying another suite's
   * in-flight submissions, which share the same database.
   */
  onlyTenant?: string,
): Promise<PurgeStats> {
  const stats: PurgeStats = {
    payloads: 0, receipts: 0, correlations: 0, auditRows: 0,
    outboxRows: 0, deliveryRows: 0, idempotencyRows: 0, quarantineRows: 0, usageRows: 0,
  };

  await withTx(db, async (tx) => {
    await tx.query('SET LOCAL ROLE passo_purge');

    // 1. Payload + XML, once terminal.
    const p = await tx.query<{ id: string; tenant_id: string }>(
      `UPDATE sdi_submissions
          SET xml_encrypted = NULL, xml_key_version = NULL, xml_iv = NULL, xml_tag = NULL,
              purged_at = now()
        WHERE terminal_at IS NOT NULL AND purged_at IS NULL AND xml_encrypted IS NOT NULL
          AND ($1::uuid IS NULL OR tenant_id = $1)
        RETURNING id, tenant_id`,
      [onlyTenant ?? null],
    );
    stats.payloads = p.rowCount ?? 0;

    await tx.query(
      `UPDATE invoices SET payload_encrypted = NULL, payload_key_version = NULL,
              payload_iv = NULL, payload_tag = NULL, purged_at = now()
        WHERE purged_at IS NULL AND id IN (
          SELECT invoice_id FROM sdi_submissions WHERE terminal_at IS NOT NULL
        ) AND ($1::uuid IS NULL OR tenant_id = $1)`,
      [onlyTenant ?? null],
    );

    // 2. Receipts — ONLY when acknowledged and past the grace window.
    const r = await tx.query(
      `DELETE FROM notifications
        WHERE acknowledged_at IS NOT NULL
          AND purge_eligible_at IS NOT NULL
          AND purge_eligible_at < now()`,
    );
    stats.receipts = r.rowCount ?? 0;

    // 3. Correlation records past their window.
    const c = await tx.query(
      `DELETE FROM correlation_records
        WHERE expires_at IS NOT NULL AND expires_at < now()
          AND terminal_at IS NOT NULL`,
    );
    stats.correlations = c.rowCount ?? 0;

    // 4. Audit log — operational retention only.
    const a = await tx.query(
      `DELETE FROM audit_log WHERE created_at < now() - ($1 || ' months')::interval`,
      [String(cfg.AUDIT_RETENTION_MONTHS)],
    );
    stats.auditRows = a.rowCount ?? 0;

    /**
     * 5. Operational tables.
     *
     * These hold no fiscal record and are invisible to the retention story, so
     * nothing forced them to be bounded — and they grew without limit. The
     * outbox and the delivery log are the fastest-growing tables in the system:
     * one row per job and one per webhook attempt, forever.
     *
     * Each condition below is deliberately narrow — only rows whose work is
     * FINISHED are eligible. A pending outbox row is an invoice that has not
     * been published yet; deleting one by age would lose it silently.
     */
    const ob = await tx.query(
      `DELETE FROM outbox
        WHERE published_at IS NOT NULL
          AND published_at < now() - ($1 || ' days')::interval`,
      [String(cfg.OPERATIONAL_RETENTION_DAYS)],
    );
    stats.outboxRows = ob.rowCount ?? 0;

    // Delivery history: keep failures longer than successes — a success is
    // noise once it is old, a failure is what an operator investigates.
    const wd = await tx.query(
      `DELETE FROM webhook_deliveries
        WHERE created_at < now() - ($1 || ' days')::interval
          AND delivered_at IS NOT NULL`,
      [String(cfg.OPERATIONAL_RETENTION_DAYS)],
    );
    stats.deliveryRows = wd.rowCount ?? 0;

    // Idempotency keys outlive their usefulness the moment no client would
    // still retry with them; the window must exceed any client's retry budget.
    const ik = await tx.query(
      `DELETE FROM idempotency_keys
        WHERE created_at < now() - ($1 || ' days')::interval`,
      [String(cfg.IDEMPOTENCY_RETENTION_DAYS)],
    );
    stats.idempotencyRows = ik.rowCount ?? 0;

    // Usage metering: operational telemetry, bounded like the rest.
    const uu = await tx.query(
      `DELETE FROM api_key_usage WHERE at < now() - ($1 || ' days')::interval`,
      [String(cfg.OPERATIONAL_RETENTION_DAYS)]);
    stats.usageRows = uu.rowCount ?? 0;

    // Quarantine: ONLY rows an operator has explicitly resolved. An unresolved
    // quarantined receipt is a legal document whose owner is still unknown —
    // age is never a reason to discard one.
    const qn = await tx.query(
      `DELETE FROM quarantined_notifications
        WHERE resolved_at IS NOT NULL
          AND resolved_at < now() - ($1 || ' days')::interval`,
      [String(cfg.OPERATIONAL_RETENTION_DAYS)],
    );
    stats.quarantineRows = qn.rowCount ?? 0;

    // Every purge is itself audited.
    for (const row of p.rows) {
      await audit(tx, {
        tenantId: row.tenant_id, actor: 'purge-job', action: 'payload.purge',
        resourceType: 'submission', resourceId: row.id,
        detail: { reason: 'terminal receipt received' },
      });
    }
  });

  log.info(stats, 'purge complete');
  return stats;
}

export function startPurgeScheduler(
  db: Db, cfg: Config, log: Logger, intervalMs = 3_600_000,
): { stop: () => void } {
  const t = setInterval(() => {
    void runPurge(db, cfg, log).catch((e) => log.error({ err: e }, 'purge failed'));
  }, intervalMs);
  return { stop: () => clearInterval(t) };
}
