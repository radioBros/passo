import type { Db } from '../infra/db/pool.ts';
import { withTx, withTenant } from '../infra/db/pool.ts';
import { channelForTenant } from '../infra/channels/registry.ts';
import { ingestVendorReceipts } from '../domain/notification/service.ts';
import type { KeyProvider } from '../infra/crypto/keys.ts';
import type { Logger } from '../shared/logger.ts';
import type { Redis } from 'ioredis';
import { acquireMailboxLock } from '../infra/queue/mailbox-lock.ts';
import { STATE } from '../domain/submission/state.ts';
import { alert } from '../domain/alert/service.ts';
import { alertForChannelCode } from '../domain/alert/kinds.ts';
import { ChannelError } from '../infra/channels/types.ts';

/**
 * Re-read receipts from API vendors (OpenAPI.it).
 *
 * The vendor PUSHES receipts to a webhook — but a webhook that is down, mis-
 * configured or unreachable (any self-hosted box without a public URL) means a
 * receipt that never arrives, and nothing errors. Polling the vendor by its own
 * handle is the fallback that makes delivery not depend on that.
 *
 * Only submissions still waiting on SdI are read: `transmitted` and
 * `awaiting_delivery` (MC), plus a B2G invoice already `delivered` for up to 20
 * days — the public administration's NE (accept/reject) can follow within the
 * 15-day window. Ingestion is idempotent, so re-reading changes nothing.
 */
export function startVendorPoller(
  db: Db, keys: KeyProvider, log: Logger, intervalMs: number,
  redis: Redis | null = null,
  /** Most invoices read per tenant per tick; a backlog drains over several ticks. */
  batch = 200,
): { stop: () => void; tick: () => Promise<void> } {
  let stopped = false;
  let running = false;

  const pollTenant = async (tenantId: string): Promise<void> => {
    const { adapter, config } = await channelForTenant(db, keys, tenantId);
    if (!adapter.fetchReceipts) return;

    const pending = await withTenant(db, tenantId, (tx) => tx.query<{
      id: string; channel_ref: string; has_sdi_id: boolean;
    }>(
      `SELECT s.id, s.channel_ref, s.identificativo_sdi IS NOT NULL AS has_sdi_id
         FROM sdi_submissions s JOIN invoices i ON i.id = s.invoice_id
        WHERE s.channel = $1 AND s.channel_ref IS NOT NULL
          AND (s.state IN ($2, $3)
               OR (s.state = $4 AND i.format_trasmissione = 'FPA12'
                   AND s.submitted_at > now() - interval '20 days'))
        ORDER BY s.submitted_at NULLS LAST
        LIMIT $5`,
      [adapter.name, STATE.transmitted, STATE.awaitingDelivery, STATE.delivered, batch]));

    for (const s of pending.rows) {
      if (stopped) return;
      try {
        // SdI's id is fetched once; afterwards the poll uses only free calls.
        const receipts = await adapter.fetchReceipts(config, s.channel_ref, { withIds: !s.has_sdi_id });
        const results = await ingestVendorReceipts(
          db, keys, log, tenantId, s.id, adapter.name, receipts);
        if (receipts.poison.length) {
          await alert({ tenantId, kind: 'receipt.quarantined', channel: adapter.name,
            detail: { submissionId: s.id, count: receipts.poison.length } });
        }
        const applied = results.filter((r) => r.status === 'applied');
        if (applied.length) {
          log.info({ tenantId, submissionId: s.id, applied: applied.length },
            'vendor receipts applied');
        }
      } catch (err) {
        // One bad invoice must not stop the rest of the tenant's backlog.
        log.error({ err, tenantId, submissionId: s.id }, 'vendor receipt poll FAILED for submission');
        // Account problems (credit, setup, credentials) are worth a person's
        // attention; a transient vendor blip while polling is not — it retries.
        const kind = err instanceof ChannelError ? alertForChannelCode(err.code) : null;
        if (kind && kind !== 'channel.unavailable') {
          await alert({ tenantId, kind, channel: adapter.name,
            detail: { while: 'reading receipts', error: (err as Error).message.slice(0, 300) } });
        }
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (running) return;          // a slow tick never overlaps the next
    running = true;
    try {
      // Enumerating tenants happens before any tenant is known: read through
      // the minimal active_channels view under passo_relay, as the PEC poller does.
      const tenants = await withTx(db, async (tx) => {
        await tx.query('SET LOCAL ROLE passo_relay');
        return tx.query<{ tenant_id: string }>(
          `SELECT tenant_id FROM active_channels WHERE channel = 'openapi'`);
      });
      for (const { tenant_id: tenantId } of tenants.rows) {
        if (stopped) return;
        const lock = await acquireMailboxLock(redis, `vendor:${tenantId}`, intervalMs * 2, log);
        if (!lock) continue;      // another worker replica has this tenant
        try {
          await pollTenant(tenantId);
        } catch (err) {
          log.error({ err, tenantId }, 'vendor receipt poll FAILED for tenant');
          await alert({ tenantId, kind: 'channel.unreadable', channel: 'openapi',
            detail: { while: 'reading receipts', error: (err as Error).message.slice(0, 300) } });
        } finally {
          await lock.release();
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { if (!stopped) void tick(); }, intervalMs);
  return { stop: () => { stopped = true; clearInterval(timer); }, tick };
}
