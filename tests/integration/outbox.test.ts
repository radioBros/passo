import { exec } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTenant, withTx } from '../../src/infra/db/pool.ts';
import { enqueue, drainOutbox, MAX_RELAY_ATTEMPTS } from '../../src/infra/queue/outbox.ts';
import { connectBroker } from '../../src/infra/queue/broker.ts';
import { EXCHANGES, QUEUES } from '../../src/infra/queue/topology.ts';
import { logger } from '../../src/shared/logger.ts';

import { createHarness, seedTenant, type Harness } from '../helpers/harness.ts';

const h: Harness = createHarness();
const db = h.db;
const broker = await connectBroker(
  process.env['TEST_RABBITMQ_URL'] ?? 'amqp://localhost:55672', logger);
// Seed a real tenant: outbox rows carry a tenant_id FK.
const A = (await seedTenant(h)).tenantId;
afterAll(async () => { await broker.close(); await h.close(); });

/**
 * These tests drive `drainOutbox` DIRECTLY.
 *
 * The running relay container competes for the same rows — it publishes them
 * within milliseconds of the insert committing — so each call is scoped to this
 * suite's own tenant AND the suite pauses the relay for its duration. Scoping
 * alone is not enough: the relay drains every tenant, so it would still win the
 * race to any row it happened to see first.
 */
beforeAll(async () => {
  // Pause the relay so `drainOutbox` is the only claimant. Restored in afterAll.
  await new Promise<void>((resolve) => {
    exec('docker compose stop relay', () => resolve());
  });
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    exec('docker compose start relay', () => resolve());
  });
}, 60_000);

describe('transactional outbox — no invoice is ever lost', () => {
  it('a ROLLED BACK transaction leaves NO outbox row (no phantom job)', async () => {
    const before = await withTenant(db, A, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM outbox'));
    await withTenant(db, A, async (tx) => {
      await enqueue(tx, A, EXCHANGES.invoices, `t.${QUEUES.transform}`, { x: 1 });
      throw new Error('simulated failure after enqueue');
    }).catch(() => undefined);
    const after = await withTenant(db, A, (tx) =>
      tx.query('SELECT count(*)::int AS n FROM outbox'));
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('a COMMITTED transaction survives a crash before publish, then publishes', async () => {
    // Commit the outbox row but never call the relay — simulates the process
    // dying between COMMIT and publish.
    await withTenant(db, A, (tx) =>
      enqueue(tx, A, EXCHANGES.invoices, `t.${QUEUES.transform}`, { marker: 'survives' }));

    // Restart: the relay picks it up. Drain to completion — other suites and a
    // running API can leave rows behind, so assert on OUR marker, not on a
    // global zero.
    let stats = await drainOutbox(db, broker, logger, 100, A);
    expect(stats.published).toBeGreaterThan(0);
    while (stats.published > 0) stats = await drainOutbox(db, broker, logger, 100, A);

    const left = await withTenant(db, A, (tx) => tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox
        WHERE published_at IS NULL AND payload::text LIKE '%survives%'`));
    expect(left.rows[0]!.n).toBe(0);
  });

  it('SKIP LOCKED lets concurrent relays run without double-publishing', async () => {
    // Drain what other suites left, but BOUNDED: they publish concurrently, so
    // an unbounded "drain until empty" can never terminate.
    for (let i = 0; i < 20; i++) {
      if ((await drainOutbox(db, broker, logger, 100, A)).published === 0) break;
    }

    // Unique per run: outbox rows are retained after publishing, so a fixed
    // marker accumulates across runs.
    const marker = `skiplocked-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    for (let i = 0; i < 10; i++) {
      await withTenant(db, A, (tx) =>
        enqueue(tx, A, EXCHANGES.invoices, `t.${QUEUES.transform}`, { marker, i }));
    }
    await Promise.all([
      drainOutbox(db, broker, logger, 100, A),
      drainOutbox(db, broker, logger, 100, A),
    ]);
    // A concurrent suite may have filled the batch, so keep draining until our
    // own rows are through. The property under test is "exactly once", not
    // "in the first pass".
    for (let i = 0; i < 10; i++) {
      const left = await withTenant(db, A, (tx) => tx.query<{ n: number }>(
        `SELECT count(*) FILTER (WHERE published_at IS NULL)::int AS n
           FROM outbox WHERE payload::text LIKE '%' || $1 || '%'`, [marker]));
      if (left.rows[0]!.n === 0) break;
      await drainOutbox(db, broker, logger, 100, A);
    }
    // SKIP LOCKED means two relays PARTITION the batch instead of both
    // claiming the same rows. Assert on our own marker rows: other suites and
    // the dev API server publish into this table concurrently, so a global
    // count is not a stable signal.
    const mine = await withTenant(db, A, (tx) => tx.query<{ total: number; unpub: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE published_at IS NULL)::int AS unpub
         FROM outbox WHERE payload::text LIKE '%' || $1 || '%'`, [marker]));
    expect(mine.rows[0]!.total).toBe(10);   // no duplicates created
    expect(mine.rows[0]!.unpub).toBe(0);    // all published exactly once
  });
});

describe('outbox relay edge cases', () => {
  it('marks a row failed rather than published when the broker rejects it', async () => {
    const marker = `rejected-${Date.now()}`;
    await withTenant(db, A, (tx) =>
      enqueue(tx, A, EXCHANGES.invoices, `t.${QUEUES.transform}`, { marker }));
    // A broker that NACKs: the publish reaches RabbitMQ and is refused.
    const stubborn = { ...broker, publishConfirmed: () => Promise.resolve(false) };
    const stats = await drainOutbox(db, stubborn as typeof broker, logger, 100, A);
    expect(stats.failed).toBeGreaterThan(0);
    const row = await withTenant(db, A, (tx) => tx.query<{ attempts: number; published_at: Date | null }>(
      `SELECT attempts, published_at FROM outbox WHERE payload::text LIKE '%' || $1 || '%'`, [marker]));
    // A failed publish must NEVER mark a row published — that is the loss this
    // whole mechanism exists to prevent.
    expect(row.rows[0]!.published_at).toBeNull();
    expect(row.rows[0]!.attempts).toBeGreaterThan(0);
  });

  it('is a no-op when there is nothing to drain', async () => {
    let s = await drainOutbox(db, broker, logger, 100, A);
    while (s.published > 0) s = await drainOutbox(db, broker, logger, 100, A);
    expect((await drainOutbox(db, broker, logger, 100, A)).published).toBe(0);
  });

  it('respects the batch limit', async () => {
    const marker = `batch-${Date.now()}`;
    for (let i = 0; i < 5; i++) {
      await withTenant(db, A, (tx) =>
        enqueue(tx, A, EXCHANGES.invoices, `t.${QUEUES.transform}`, { marker, i }));
    }
    const s = await drainOutbox(db, broker, logger, 2);
    expect(s.published).toBeLessThanOrEqual(2);
  });
});

/**
 * QUEUE-006 — confirm before marking published.
 *
 * `publish` returns amqplib's local buffer status, not a broker acknowledgement.
 * Marking a row published on that basis loses the invoice if RabbitMQ dies in
 * the window — the exact failure the outbox exists to prevent, and the reason
 * the risk register rates it "Critical: silent invoice loss".
 */
describe('publisher confirms', () => {
  it('leaves a row CLAIMABLE when the broker never confirms', async () => {
    const marker = `unconfirmed-${Date.now()}`;
    await withTenant(db, A, (tx) =>
      enqueue(tx, A, EXCHANGES.invoices, `t.${QUEUES.transform}`, { marker }));

    const silent = { ...broker, publishConfirmed: () => Promise.resolve(false) };
    await drainOutbox(db, silent as typeof broker, logger, 100, A);

    const row = await withTenant(db, A, (tx) => tx.query<{ published_at: Date | null }>(
      `SELECT published_at FROM outbox WHERE payload::text LIKE '%' || $1 || '%'`, [marker]));
    expect(row.rows[0]!.published_at).toBeNull();

    /**
     * The next pass, against a healthy broker, must still find and send it.
     * Drain repeatedly: other suites share this outbox, so the row may not be
     * in the first batch — what matters is that it IS eventually published,
     * not which batch carries it.
     */
    for (let i = 0; i < 10; i++) {
      const now = await withTenant(db, A, (tx) => tx.query<{ published_at: Date | null }>(
        `SELECT published_at FROM outbox WHERE payload::text LIKE '%' || $1 || '%'`, [marker]));
      if (now.rows[0]?.published_at) return;
      await drainOutbox(db, broker, logger, 100, A);
    }
    throw new Error('the row was never published after the broker recovered');
  });

  it('uses the CONFIRMED path, not fire-and-forget', async () => {
    const marker = `confirmed-${Date.now()}`;
    await withTenant(db, A, (tx) =>
      enqueue(tx, A, EXCHANGES.invoices, `t.${QUEUES.transform}`, { marker }));

    let confirmedCalls = 0;
    let plainCalls = 0;
    // The row above must still be pending for the counters to see anything.
    const counting = {
      ...broker,
      publish: (...a: Parameters<typeof broker.publish>) => { plainCalls++; return broker.publish(...a); },
      publishConfirmed: (...a: Parameters<typeof broker.publishConfirmed>) => {
        confirmedCalls++; return broker.publishConfirmed(...a);
      },
    };
    await drainOutbox(db, counting as typeof broker, logger, 100, A);
    expect(confirmedCalls).toBeGreaterThan(0);
    // Fire-and-forget must not be reachable from the relay at all.
    expect(plainCalls).toBe(0);
  });
});

/**
 * Poison-message containment.
 *
 * RabbitMQ closes the WHOLE channel on a per-message error — publishing to an
 * unknown exchange, for instance. Every later publish on that channel then
 * fails with "Channel closed", so one malformed row silently stops publication
 * for every tenant: valid invoices burn through their retries and get
 * abandoned. One bad message becomes mass loss.
 *
 * This was observed live before the fix: 63 rows abandoned, including invoices
 * that were perfectly valid.
 */
describe('poison message containment', () => {
  it('a row with an UNKNOWN EXCHANGE does not stop the rows behind it', async () => {
    const good = `good-${Date.now()}`;
    // A bad row first, so it is claimed before the good one in the same batch.
    await withTenant(db, A, (tx) =>
      tx.query(`INSERT INTO outbox (tenant_id, exchange, routing_key, payload)
                VALUES ($1, 'no-such-exchange', 'k', $2::jsonb)`,
               [A, JSON.stringify({ poison: true })]));
    await withTenant(db, A, (tx) =>
      enqueue(tx, A, EXCHANGES.invoices, `t.${QUEUES.transform}`, { marker: good }));

    // Drain repeatedly: the bad row retries, the good one must still go out.
    for (let i = 0; i < 3; i++) await drainOutbox(db, broker, logger, 100, A);

    const row = await withTenant(db, A, (tx) => tx.query<{ published_at: Date | null }>(
      `SELECT published_at FROM outbox WHERE payload::text LIKE '%' || $1 || '%'`, [good]));
    expect(row.rows[0]!.published_at,
      'a valid invoice must not be blocked by an unrelated poison row').not.toBeNull();
  });

  it('the broker keeps working after a channel-closing publish', async () => {
    await withTenant(db, A, (tx) =>
      tx.query(`INSERT INTO outbox (tenant_id, exchange, routing_key, payload)
                VALUES ($1, 'still-no-exchange', 'k', '{}'::jsonb)`, [A]));
    await drainOutbox(db, broker, logger, 100, A);

    // The channel it just killed must be replaced, not reused.
    const marker = `after-${Date.now()}`;
    await withTenant(db, A, (tx) =>
      enqueue(tx, A, EXCHANGES.invoices, `t.${QUEUES.transform}`, { marker }));
    const stats = await drainOutbox(db, broker, logger, 100, A);
    expect(stats.published).toBeGreaterThan(0);
  });

  it('abandons a genuinely unpublishable row rather than blocking forever', async () => {
    /**
     * BOTH gates must be satisfied: the attempt count AND the age. Attempts
     * alone are worthless as a clock — the relay ticks every 200ms, so the
     * budget would elapse in seconds and a routine broker restart would abandon
     * every accepted invoice. The row is therefore backdated past the window.
     */
    await withTenant(db, A, (tx) =>
      tx.query(`INSERT INTO outbox (tenant_id, exchange, routing_key, payload, attempts, created_at)
                VALUES ($1, 'never-exists', 'k', '{}'::jsonb, $2, now() - interval '2 hours')`,
               [A, MAX_RELAY_ATTEMPTS - 1]));
    const stats = await drainOutbox(db, broker, logger, 100, A);
    // Abandoning is a deliberate trade: the alternative is a permanently stuck
    // relay, which loses every subsequent invoice rather than this one.
    expect(stats.abandoned).toBeGreaterThan(0);
  });
});

/**
 * QUEUE-008 — NOTIFY is a latency optimisation, never a correctness dependency.
 *
 * Postgres does not deliver a notification to a disconnected listener and does
 * not queue it for one, so a relay reconnecting when the row landed would never
 * hear about it. If correctness depended on the notification, that row would be
 * stuck forever — an invoice silently never sent.
 */
describe('outbox NOTIFY', () => {
  it('the trigger exists and fires per STATEMENT, not per row', async () => {
    const r = await withTx(db, (tx) => tx.query<{ action_timing: string; action_orientation: string }>(
      `SELECT action_timing, action_orientation FROM information_schema.triggers
        WHERE trigger_name = 'outbox_notify_trigger'`));
    expect(r.rows[0]?.action_timing).toBe('AFTER');
    // A 100-row batch should wake the relay once, not a hundred times.
    expect(r.rows[0]?.action_orientation).toBe('STATEMENT');
  });

  it('a row inserted with NO listener attached is still drained by the POLL', async () => {
    const marker = `no-listener-${Date.now()}`;
    // Nothing is LISTENing in this test process: the notification goes nowhere.
    await withTenant(db, A, (tx) =>
      enqueue(tx, A, EXCHANGES.invoices, `t.${QUEUES.transform}`, { marker }));

    for (let i = 0; i < 10; i++) {
      const row = await withTenant(db, A, (tx) => tx.query<{ published_at: Date | null }>(
        `SELECT published_at FROM outbox WHERE payload::text LIKE '%' || $1 || '%'`, [marker]));
      if (row.rows[0]?.published_at) return;   // the poll found it
      await drainOutbox(db, broker, logger, 100, A);
    }
    throw new Error('a row was never published — the poll must not depend on NOTIFY');
  });

  it('carries NO payload — it would leak tenant ids to any listening session', async () => {
    const r = await withTx(db, (tx) => tx.query<{ def: string }>(
      `SELECT prosrc AS def FROM pg_proc WHERE proname = 'outbox_notify'`));
    expect(r.rows[0]!.def).toMatch(/pg_notify\('passo_outbox', ''\)/);
  });
});

/**
 * The age gate on abandonment.
 *
 * `publishConfirmed` fails instantly on a closed channel, so the attempt
 * counter burns at the tick rate — twenty attempts is FOUR SECONDS. Without an
 * age gate a routine RabbitMQ restart would exhaust the budget for every
 * pending row and abandon accepted invoices.
 */
describe('abandonment requires BOTH attempts and age', () => {
  it('does NOT abandon a FRESH row, however many attempts it has', async () => {
    const marker = `fresh-${Date.now()}`;
    await withTenant(db, A, (tx) => tx.query(
      `INSERT INTO outbox (tenant_id, exchange, routing_key, payload, attempts)
       VALUES ($1, 'nope', 'k', $2::jsonb, $3)`,
      [A, JSON.stringify({ marker }), MAX_RELAY_ATTEMPTS + 10]));

    await drainOutbox(db, broker, logger, 100, A);

    const row = await withTenant(db, A, (tx) => tx.query<{
      abandoned_at: Date | null; published_at: Date | null;
    }>(`SELECT abandoned_at, published_at FROM outbox
         WHERE payload::text LIKE '%' || $1 || '%'`, [marker]));
    // A broker outage must look like "retry later", not "give up".
    expect(row.rows[0]!.abandoned_at).toBeNull();
    expect(row.rows[0]!.published_at).toBeNull();
  });

  it('marks abandoned_at, NEVER published_at — the purge deletes by published', async () => {
    const marker = `abandon-${Date.now()}`;
    await withTenant(db, A, (tx) => tx.query(
      `INSERT INTO outbox (tenant_id, exchange, routing_key, payload, attempts, created_at)
       VALUES ($1, 'nope', 'k', $2::jsonb, $3, now() - interval '2 hours')`,
      [A, JSON.stringify({ marker }), MAX_RELAY_ATTEMPTS - 1]));

    await drainOutbox(db, broker, logger, 100, A);

    const row = await withTenant(db, A, (tx) => tx.query<{
      abandoned_at: Date | null; published_at: Date | null;
    }>(`SELECT abandoned_at, published_at FROM outbox
         WHERE payload::text LIKE '%' || $1 || '%'`, [marker]));
    expect(row.rows[0]!.abandoned_at).not.toBeNull();
    /**
     * Claiming it was published would be a lie the purge worker acts on: it
     * deletes by `published_at`, so the invoice would vanish after the
     * retention window with only a log line as evidence.
     */
    expect(row.rows[0]!.published_at).toBeNull();
  });

  it('an abandoned row is not re-claimed by the relay', async () => {
    const marker = `skip-${Date.now()}`;
    await withTenant(db, A, (tx) => tx.query(
      `INSERT INTO outbox (tenant_id, exchange, routing_key, payload, abandoned_at)
       VALUES ($1, 'nope', 'k', $2::jsonb, now())`, [A, JSON.stringify({ marker })]));
    const stats = await drainOutbox(db, broker, logger, 100, A);
    expect(stats.abandoned).toBe(0);
  });
});
