import type { Db, Tx } from '../infra/db/pool.ts';
import { withTx } from '../infra/db/pool.ts';
import type { Logger } from '../shared/logger.ts';
import { alert } from '../domain/alert/service.ts';

/**
 * Stalled-submission detection (NOTIF-023).
 *
 * A submission that reaches SdI and never hears back is the failure mode with
 * no natural error: nothing throws, no retry fires, no queue grows. It simply
 * waits, and without this it waits forever.
 *
 * Two causes need different treatment, because conflating them produces either
 * false alarms or silence:
 *
 *   - **Our ingress stopped.** The PEC poller died, or a vendor webhook is no
 *     longer reaching us. Every waiting submission on that channel is affected
 *     at once, and it is our fault. Detected by poll-cycle staleness, so it is
 *     caught even when nothing is currently in flight.
 *
 *   - **SdI is slow.** SdI has up to 5 days to deliver a B2B invoice, and much
 *     longer for a B2G outcome. A submission older than a channel-specific
 *     threshold is worth reporting, but it is NOT evidence anything is broken —
 *     so it is reported at a lower severity and never as a poller failure.
 *
 * The distinguishing signal is breadth: many submissions stalling together on
 * one channel, with a stale poll cycle, means ingress. One old submission on a
 * healthy channel means SdI.
 */

/** Per-channel patience, in hours, before a waiting submission is reported. */
export const STALL_THRESHOLD_HOURS: Record<string, number> = {
  // SdI's own limit for B2B delivery is 5 days; report at 6 to avoid noise.
  pec: 144,
  invoicetronic: 144,
  openapi: 144,
  mock: 1,
};

/** A poll cycle older than this means the ingress path itself has stopped. */
export const POLLER_STALE_MINUTES = 30;

export interface StallReport {
  ingressStalled: Array<{ channel: string; lastPollAt: Date | null; waiting: number }>;
  slowSubmissions: Array<{ channel: string; count: number; oldestHours: number }>;
  /** MC submissions past SdI's own delivery window (QUEUE-020). */
  mcExpired: Array<{ count: number; oldestDays: number }>;
}

/**
 * SdI attempts delivery of an MC for up to 30 days, then issues an AT.
 *
 * An MC still sitting here past that window means the AT never arrived — the
 * receipt was lost, not that SdI is still trying. The invoice IS legally
 * issued, so this is not a failure to fix; it is a reconciliation gap where the
 * seller may need to hand the invoice over by other means and does not know it.
 *
 * Checked, never RETRIED: resubmitting a legally issued invoice duplicates it.
 */
export const MC_WINDOW_DAYS = 30;

/**
 * Inspect waiting submissions and ingress liveness.
 *
 * Runs under `passo_relay`: the question "is anything stuck anywhere" spans
 * tenants by nature, and the view exposes only channel and timing, never
 * invoice content.
 */
export async function detectStalls(db: Db, log: Logger): Promise<StallReport> {
  const report: StallReport = { ingressStalled: [], slowSubmissions: [], mcExpired: [] };

  await withTx(db, async (tx: Tx) => {
    await tx.query('SET LOCAL ROLE passo_relay');

    // Poll-cycle staleness: catches a dead poller even with nothing in flight.
    const pollers = await tx.query<{
      channel: string; last_poll_at: Date | null; waiting: string;
    }>(`
      SELECT c.channel,
             c.last_poll_at,
             COALESCE(w.waiting, 0)::text AS waiting
        FROM channel_health c
        LEFT JOIN (
          SELECT s.channel, count(*) AS waiting
            FROM submission_wait_status s
           GROUP BY s.channel
        ) w ON w.channel = c.channel
       WHERE c.poll_based
    `);

    for (const p of pollers.rows) {
      const ageMin = p.last_poll_at
        ? (Date.now() - new Date(p.last_poll_at).getTime()) / 60_000
        : Number.POSITIVE_INFINITY;
      if (ageMin > POLLER_STALE_MINUTES) {
        report.ingressStalled.push({
          channel: p.channel, lastPollAt: p.last_poll_at, waiting: Number(p.waiting),
        });
        log.error(
          { channel: p.channel, lastPollAt: p.last_poll_at, waiting: Number(p.waiting),
            staleMinutes: Math.round(ageMin) },
          `INGRESS STALLED: the ${p.channel} poller has not completed a cycle in ` +
          `${Math.round(ageMin)} minutes. Notifications are NOT being collected — ` +
          'this is a PASSO-side failure, not SdI being slow. Check the poller process ' +
          'and the mailbox credentials.',
        );
        await alert({ tenantId: null, kind: 'system.ingress_stalled', channel: p.channel,
          detail: { lastPollAt: p.last_poll_at, waiting: Number(p.waiting), staleMinutes: Math.round(ageMin) } });
      }
    }

    // Genuinely slow SdI: reported, but never as a failure.
    const slow = await tx.query<{ channel: string; count: string; oldest_hours: number }>(`
      SELECT channel, count(*)::text AS count,
             EXTRACT(EPOCH FROM (now() - min(submitted_at))) / 3600 AS oldest_hours
        FROM submission_wait_status
       WHERE submitted_at IS NOT NULL
       GROUP BY channel
    `);

    for (const s of slow.rows) {
      const threshold = STALL_THRESHOLD_HOURS[s.channel] ?? 144;
      if (s.oldest_hours > threshold) {
        report.slowSubmissions.push({
          channel: s.channel, count: Number(s.count), oldestHours: Math.round(s.oldest_hours),
        });
        // warn, not error: SdI taking its time is expected behaviour.
        log.warn(
          { channel: s.channel, count: Number(s.count), oldestHours: Math.round(s.oldest_hours),
            thresholdHours: threshold },
          `${s.count} submission(s) on ${s.channel} have awaited a receipt for over ` +
          `${threshold}h. If the poller is healthy this is SdI being slow, which is ` +
          'within its normal window — no action beyond monitoring.',
        );
      }
    }

    /**
     * MC past SdI's window (QUEUE-020). A RE-CHECK, not a retry — the invoice
     * is already legally issued and resubmitting would duplicate it.
     */
    const mc = await tx.query<{ count: string; oldest_days: number }>(`
      SELECT count(*)::text AS count,
             EXTRACT(EPOCH FROM (now() - min(submitted_at))) / 86400 AS oldest_days
        FROM submission_wait_status
       WHERE state = 'awaiting_delivery' AND submitted_at IS NOT NULL
    `);
    const row = mc.rows[0];
    if (row && Number(row.count) > 0 && row.oldest_days > MC_WINDOW_DAYS) {
      report.mcExpired.push({
        count: Number(row.count), oldestDays: Math.round(row.oldest_days),
      });
      log.warn(
        { count: Number(row.count), oldestDays: Math.round(row.oldest_days) },
        `MC submissions have been awaiting delivery for over ${MC_WINDOW_DAYS} days, which ` +
        'is past the window in which SdI issues an AT. The invoices ARE legally issued — ' +
        'do NOT resubmit, which would duplicate them. The receipt was probably lost: ' +
        'reconcile against SdI and make the invoices available to the recipients directly.',
      );
    }
  });

  return report;
}

/** Run stall detection on an interval. */
export function startStallDetector(
  db: Db, log: Logger, intervalMs = 15 * 60_000,
): { stop: () => void } {
  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      await detectStalls(db, log);
    } catch (err) {
      log.error({ err }, 'stall detection failed');
    }
    if (!stopped) setTimeout(() => void tick(), intervalMs).unref();
  };
  setTimeout(() => void tick(), intervalMs).unref();
  return { stop: () => { stopped = true; } };
}
