import type { Redis } from 'ioredis';
import type { Logger } from '../../shared/logger.ts';

/**
 * Sync-mode milestone waiter (API-014).
 *
 * Dual-mode is a stated requirement: a CRM that cannot receive webhooks holds
 * the HTTP connection open until the invoice reaches SdI. This is the Redis
 * pub/sub side of that.
 *
 * Two rules, both load-bearing:
 *
 *   1. **Subscribe BEFORE the work starts.** Subscribing after the outbox
 *      commits races the pipeline: a fast AT is published to nobody, and the
 *      caller then waits the full timeout on an invoice that already succeeded.
 *      `waitFor` therefore returns a handle that is already subscribed, and the
 *      caller starts the work afterwards.
 *
 *   2. **AT only.** Never RC, MC or DT. MC delivery retry legally runs for
 *      days, so no HTTP timeout can represent final delivery — a sync wait on
 *      those would be a hang, not a wait.
 *
 * Redis is a convenience here, never a durability boundary. If it is down the
 * wait simply times out and the caller gets its 202; the invoice is untouched
 * because Postgres holds the truth.
 */

/** One channel per submission — no fan-out, no filtering on the subscriber. */
export const milestoneChannel = (submissionId: string): string =>
  `passo:milestone:${submissionId}`;

/** Milestones a sync caller may wait for. Deliberately not RC/MC/DT. */
export const SYNC_MILESTONES: ReadonlySet<string> = new Set(['transmitted', 'failed', 'rejected']);

export interface MilestoneWaiter {
  /** Resolves with the milestone, or null on timeout. */
  wait(timeoutMs: number): Promise<string | null>;
  /** Always call — a leaked subscriber connection outlives the request. */
  close(): Promise<void>;
}

/**
 * Begin listening. Call this BEFORE enqueuing the work.
 *
 * `ioredis` puts a connection into subscriber mode exclusively, so this
 * duplicates the client rather than borrowing it — a shared connection would
 * stop serving ordinary commands for the whole application.
 */
export async function watchMilestone(
  redis: Redis, submissionId: string, log?: Logger,
): Promise<MilestoneWaiter> {
  const sub = redis.duplicate();
  const channel = milestoneChannel(submissionId);
  let settle: ((v: string | null) => void) | null = null;
  let received: string | null = null;

  sub.on('message', (_ch: string, message: string) => {
    // Hold the value even if nobody is waiting yet: the milestone can arrive
    // between subscribing and the caller reaching wait().
    received = message;
    settle?.(message);
  });
  sub.on('error', (err: Error) => log?.warn({ err, submissionId }, 'milestone subscriber error'));

  await sub.subscribe(channel);

  return {
    async wait(timeoutMs: number): Promise<string | null> {
      if (received) return received;
      return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => { settle = null; resolve(null); }, timeoutMs);
        settle = (v) => { clearTimeout(timer); resolve(v); };
      });
    },
    async close(): Promise<void> {
      settle = null;
      try { await sub.unsubscribe(channel); } catch { /* connection already gone */ }
      sub.disconnect();
    },
  };
}

/**
 * Announce that a submission reached a milestone.
 *
 * Best-effort by design: a failed publish must never fail the pipeline. The
 * worst case is a sync caller waiting out its timeout and receiving a 202,
 * which is exactly what an async caller would have received anyway.
 */
export async function publishMilestone(
  redis: Redis | null, submissionId: string, milestone: string, log?: Logger,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.publish(milestoneChannel(submissionId), milestone);
  } catch (err) {
    log?.warn({ err, submissionId, milestone }, 'milestone publish failed — sync waiters will time out');
  }
}
