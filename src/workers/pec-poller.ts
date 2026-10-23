import type { Db } from '../infra/db/pool.ts';
import { withTx } from '../infra/db/pool.ts';
import { channelForTenant, recordAssignedPecAddress } from '../infra/channels/registry.ts';
import { ingestNotification, quarantinePoison } from '../domain/notification/service.ts';
import { detectAssignedAddress } from '../infra/channels/pec.ts';
import type { KeyProvider } from '../infra/crypto/keys.ts';
import type { Config } from '../shared/config.ts';
import type { Logger } from '../shared/logger.ts';
import type { Redis } from 'ioredis';
import { acquireMailboxLock } from '../infra/queue/mailbox-lock.ts';
import { alert, resolved } from '../domain/alert/service.ts';

/**
 * PEC receipt poller.
 *
 * PEC is the only channel with no webhook: SdI replies by email, so PASSO must
 * fetch. IMAP, never POP3 — POP3 deletes on read, so a crash mid-processing
 * loses a legal receipt permanently, and the mailbox is the only copy.
 *
 * A per-tenant lock prevents two pollers opening the same mailbox: most PEC
 * providers cap concurrent IMAP connections.
 */
export function startPecPoller(
  db: Db, keys: KeyProvider, log: Logger, cfg: Config,
  intervalMs = cfg.PEC_POLL_INTERVAL_MS,
  /** Absent means single-worker: the in-process guard is then sufficient. */
  redis: Redis | null = null,
): { stop: () => void } {
  let stopped = false;
  const inFlight = new Set<string>();

  const tick = async (): Promise<void> => {
    // Enumerating tenants must happen BEFORE any tenant is known, so it cannot
    // run under an app.tenant_id context. Reading channel_credentials directly
    // here returns ZERO rows under RLS — the poller would silently never poll.
    // The active_channels view exposes only (tenant_id, channel) and is read
    // through passo_relay.
    const tenants = await withTx(db, async (tx) => {
      await tx.query('SET LOCAL ROLE passo_relay');
      return tx.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM active_channels WHERE channel = 'pec'`);
    });

    let cycleOk = true;
    for (const { tenant_id: tenantId } of tenants.rows) {
      if (inFlight.has(tenantId)) continue;   // still polling from last tick

      /**
       * The in-process guard covers this worker; the Redis lock covers a
       * SECOND replica. Many PEC providers cap concurrent IMAP connections, so
       * two pollers on one mailbox burn the quota and double the work.
       */
      const lock = await acquireMailboxLock(redis, tenantId, intervalMs * 2, log);
      if (!lock) continue;   // another poller has it

      inFlight.add(tenantId);
      try {
        const { adapter, config } = await channelForTenant(db, keys, tenantId);
        if (!adapter.poll) continue;
        const { notifications, poison } = await adapter.poll(config);

        /**
         * Acknowledge only what is durably stored.
         *
         * A message is marked `\Seen` only once EVERY item extracted from it —
         * each notification ingested, each poison part quarantined — is stored.
         * One email can carry several attachments; acknowledging on the first
         * success used to lose the rest. A handle with any failure stays unread
         * and is retried next tick. The mailbox is the only copy of a legal
         * receipt; re-ingesting is idempotent, losing one is not recoverable.
         */
        const persisted = new Set<string>();
        const failed = new Set<string>();
        for (const p of poison) {
          try {
            await quarantinePoison(db, p, 'pec', tenantId);
            persisted.add(p.receiptHandle);
            log.error({ tenantId, reason: p.reason, filename: p.filename },
              'PEC message could not be processed — QUARANTINED for operator review');
            await alert({ tenantId, kind: 'receipt.quarantined', channel: 'pec',
              detail: { reason: p.reason.slice(0, 200), filename: p.filename ?? null } });
          } catch (err) {
            failed.add(p.receiptHandle);
            log.error({ err, tenantId }, 'PEC poison quarantine FAILED — left unread for retry');
          }
        }
        for (const n of notifications) {
          try {
            // SdI assigns a per-transmitter address in its FIRST reply. Missing
            // it means later submissions keep going to sdi01@, where delivery is
            // explicitly "not guaranteed" — and fails SILENTLY.
            const assigned = detectAssignedAddress(n.raw.match(/[\w.]+@pec\.fatturapa\.it/)?.[0]);
            if (assigned) {
              await recordAssignedPecAddress(db, tenantId, assigned);
              log.info({ tenantId, assigned }, 'SdI assigned a dedicated PEC address');
            }
            // This mailbox belongs to ONE tenant; anyone can email an address, so a
            // receipt landing here must not be allowed to mutate another tenant.
            await ingestNotification(db, keys, log, n, 'pec', tenantId);
            if (n.receiptHandle) persisted.add(n.receiptHandle);
          } catch (err) {
            // Left unacknowledged on purpose: it will be re-fetched next tick.
            if (n.receiptHandle) failed.add(n.receiptHandle);
            log.error({ err, tenantId, identificativoSdI: n.identificativoSdI },
              'PEC notification ingest FAILED — left unread for retry');
          }
        }

        const ackable = [...persisted].filter((h) => !failed.has(h));
        if (adapter.acknowledge && ackable.length > 0) {
          await adapter.acknowledge(config, ackable);
          log.info({ tenantId, count: ackable.length }, 'PEC messages marked seen after persist');
        }
        if (notifications.length) {
          log.info({ tenantId, count: notifications.length }, 'PEC notifications ingested');
        }
        await resolved({ tenantId, channel: 'pec', kinds: ['pec.poll_failed'] });
      } catch (e) {
        cycleOk = false;
        log.error({ err: e, tenantId }, 'PEC poll failed');
        // The silent failure that matters most on PEC: receipts stop arriving
        // and nothing errors anywhere a person looks.
        await alert({ tenantId, kind: 'pec.poll_failed', channel: 'pec',
          detail: { error: String((e as Error).message ?? e).replace(/:\/\/[^@\s]*@/, '://[redacted]@').slice(0, 300) } });
      } finally {
        inFlight.delete(tenantId);
        await lock.release();
      }
    }

    /**
     * Record the completed cycle so a DEAD poller is detectable.
     *
     * Written only when the cycle actually finished: a poller failing every
     * tenant every tick must not look healthy. Without this heartbeat a poller
     * that dies during a quiet hour stays invisible until invoices pile up
     * behind it — see NOTIF-023 and stall-detector.ts.
     */
    if (cycleOk) {
      await withTx(db, async (tx) => {
        await tx.query('SET LOCAL ROLE passo_relay');
        await tx.query(
          `UPDATE channel_health SET last_poll_at = now(), updated_at = now()
            WHERE channel = 'pec'`);
      }).catch((err: unknown) => log.error({ err }, 'failed to record PEC poll heartbeat'));
    }
  };

  const timer = setInterval(() => { if (!stopped) void tick(); }, intervalMs);
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
