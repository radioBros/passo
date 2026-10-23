import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { acquireMailboxLock } from '../../src/infra/queue/mailbox-lock.ts';
import { logger } from '../../src/shared/logger.ts';

/**
 * Per-tenant mailbox mutex (NOTIF-029).
 *
 * The in-process guard stops ONE worker double-polling. This covers a second
 * replica — the case that matters, because many PEC providers cap concurrent
 * IMAP connections, and a provider refusing connections looks exactly like a
 * broken poller.
 */
let redis: Redis;
beforeAll(() => {
  redis = new Redis(process.env['TEST_REDIS_URL'] ?? 'redis://localhost:56379',
    { maxRetriesPerRequest: 2, lazyConnect: false });
});
afterAll(() => { redis.disconnect(); });

const tenant = () => `lock-test-${Math.random().toString(36).slice(2, 8)}`;

describe('mailbox lock', () => {
  it('grants the lock to the FIRST caller only', async () => {
    const t = tenant();
    const a = await acquireMailboxLock(redis, t, 5_000, logger);
    const b = await acquireMailboxLock(redis, t, 5_000, logger);
    expect(a).not.toBeNull();
    // A second poller must find it held, not queue behind it.
    expect(b).toBeNull();
    await a!.release();
  });

  it('releases so the next poll cycle can claim it', async () => {
    const t = tenant();
    const a = await acquireMailboxLock(redis, t, 5_000, logger);
    await a!.release();
    const b = await acquireMailboxLock(redis, t, 5_000, logger);
    expect(b).not.toBeNull();
    await b!.release();
  });

  it('is PER TENANT — one mailbox does not block another', async () => {
    const a = await acquireMailboxLock(redis, tenant(), 5_000, logger);
    const b = await acquireMailboxLock(redis, tenant(), 5_000, logger);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    await a!.release(); await b!.release();
  });

  it('EXPIRES, so a crashed poller does not hold a mailbox forever', async () => {
    const t = tenant();
    await acquireMailboxLock(redis, t, 150, logger);   // never released
    await new Promise((r) => setTimeout(r, 250));
    const after = await acquireMailboxLock(redis, t, 5_000, logger);
    expect(after).not.toBeNull();
    await after!.release();
  });

  /**
   * The classic mutex bug: a naive DEL on release deletes whatever lock is
   * there, including one a DIFFERENT poller acquired after ours expired — which
   * lets a third in. It only shows up under the load that made the poll slow
   * enough to expire.
   */
  it('releasing an EXPIRED lock does not steal the successor', async () => {
    const t = tenant();
    const first = await acquireMailboxLock(redis, t, 120, logger);
    await new Promise((r) => setTimeout(r, 200));          // first expires
    const second = await acquireMailboxLock(redis, t, 5_000, logger);
    expect(second).not.toBeNull();

    await first!.release();                                 // must be a no-op

    const third = await acquireMailboxLock(redis, t, 5_000, logger);
    expect(third, 'the expired release deleted the successor lock').toBeNull();
    await second!.release();
  });

  /**
   * A duplicated poll is idempotent; a STOPPED poller loses receipts. So a
   * Redis outage must not stop collection.
   */
  it('falls back to polling when Redis is absent', async () => {
    const l = await acquireMailboxLock(null, tenant(), 5_000, logger);
    expect(l).not.toBeNull();
    await l!.release();
  });
});
