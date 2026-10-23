import type { Redis } from 'ioredis';
import type { Logger } from '../../shared/logger.ts';

/**
 * Per-tenant mailbox mutex (NOTIF-029).
 *
 * The in-process `inFlight` guard stops ONE worker polling a mailbox twice. It
 * does nothing about a second worker replica, which is the case that matters:
 * many PEC providers cap concurrent IMAP connections, so two pollers on one
 * mailbox is both a quota failure and a correctness one — both would fetch the
 * same unseen messages and both would ingest them.
 *
 * Ingest is idempotent, so a double poll does not corrupt anything. What it
 * does is burn the provider's connection budget and double the work, and a
 * provider that starts refusing connections looks exactly like a broken poller.
 *
 * A single Redis `SET NX PX` rather than full Redlock: Redlock's guarantees
 * matter across independent Redis nodes, and PASSO runs one. Claiming Redlock
 * semantics on a single node would be a stronger promise than the deployment
 * supports.
 */

const KEY = (tenantId: string) => `passo:mailbox:${tenantId}`;

export interface MailboxLock {
  /** Release. Safe to call twice; a lost lock is not an error. */
  release(): Promise<void>;
}

/**
 * Try to claim a mailbox. Returns null when another poller holds it.
 *
 * `ttlMs` must exceed a normal poll cycle — a lock that expires mid-poll lets a
 * second poller in, which is the situation it exists to prevent — but stay
 * short enough that a crashed poller's mailbox becomes pollable again soon.
 */
export async function acquireMailboxLock(
  redis: Redis | null, tenantId: string, ttlMs = 120_000, log?: Logger,
): Promise<MailboxLock | null> {
  // No Redis: fall back to the per-process guard. A single-worker deployment
  // is the common self-hosted case and must keep working.
  if (!redis) return { release: async () => undefined };

  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const ok = await redis.set(KEY(tenantId), token, 'PX', ttlMs, 'NX');
    if (ok !== 'OK') return null;
  } catch (err) {
    // Redis down: poll anyway rather than stopping receipt collection. A
    // duplicated poll is idempotent; a stopped poller loses receipts.
    log?.warn({ err, tenantId }, 'mailbox lock unavailable — polling without it');
    return { release: async () => undefined };
  }

  return {
    async release() {
      try {
        /**
         * Release ONLY our own lock. A naive DEL would delete a lock another
         * poller acquired after ours expired, letting a third in — the classic
         * mutex bug, and one that only shows up under the load that made the
         * poll slow enough to expire in the first place.
         */
        await redis.eval(
          `if redis.call("get", KEYS[1]) == ARGV[1] then
             return redis.call("del", KEYS[1])
           else return 0 end`,
          1, KEY(tenantId), token,
        );
      } catch (err) {
        // The lock expires on its own; a failed release is not worth raising.
        log?.debug?.({ err, tenantId }, 'mailbox lock release failed — it will expire');
      }
    },
  };
}
