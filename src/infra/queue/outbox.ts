import type { Db, Tx } from '../db/pool.ts';
import type { Broker } from './broker.ts';
import type { Logger } from '../../shared/logger.ts';
import { alert } from '../../domain/alert/service.ts';

/**
 * Transactional outbox.
 *
 * The API writes the invoice row AND the outbox row in ONE transaction, then a
 * relay publishes outbox rows to RabbitMQ. This closes the dual-write window:
 * publish-then-commit leaves phantom jobs, commit-then-publish loses invoices.
 *
 * SELECT ... FOR UPDATE SKIP LOCKED makes concurrent relays correct.
 */

export async function enqueue(
  tx: Tx, tenantId: string, exchange: string, routingKey: string, payload: unknown,
): Promise<void> {
  await tx.query(
    'INSERT INTO outbox (tenant_id, exchange, routing_key, payload) VALUES ($1,$2,$3,$4)',
    [tenantId, exchange, routingKey, JSON.stringify(payload)],
  );
}

export interface RelayStats { published: number; failed: number; abandoned: number }

/**
 * When the relay gives up on a single row.
 *
 * A poison row and a broker outage look identical from one failed publish, so
 * BOTH conditions must hold before abandoning:
 *
 *   1. `MAX_RELAY_ATTEMPTS` failures, and
 *   2. the row has been pending for `MIN_RELAY_AGE_MS`.
 *
 * The age gate is the important half. Attempts alone are worthless as a clock:
 * the relay ticks every 200ms, so twenty attempts is FOUR SECONDS — a routine
 * RabbitMQ restart would have abandoned every accepted invoice, stamping
 * `published_at` on rows that were never published and leaving the purge worker
 * to delete them.
 *
 * With the age gate, an outage shorter than the window simply retries; only a
 * row the broker has refused for a sustained period is set aside.
 */
export const MAX_RELAY_ATTEMPTS = 50;
export const MIN_RELAY_AGE_MS = 30 * 60_000;   // 30 minutes

/**
 * Drain a batch. Runs WITHOUT a tenant context: the relay serves every tenant,
 * so it needs a role that can read the outbox across tenants. Each published
 * message carries its tenant_id, and the consumer sets the RLS context from it.
 */
export async function drainOutbox(
  db: Db, broker: Broker, log: Logger, batch = 100,
  /**
   * Restrict the drain to ONE tenant.
   *
   * Production never passes this — the relay serves every tenant. It exists so
   * a test can drive `drainOutbox` directly without competing with the running
   * relay container for the same rows, which otherwise makes those tests race
   * whichever process claims a row first.
   */
  onlyTenant?: string,
): Promise<RelayStats> {
  const c = await db.connect();
  const stats: RelayStats = { published: 0, failed: 0, abandoned: 0 };
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE passo_relay');
    const r = await c.query<{
      id: string; tenant_id: string; exchange: string; routing_key: string;
      payload: unknown; attempts: number; created_at: Date;
    }>(
      `SELECT id, tenant_id, exchange, routing_key, payload, attempts, created_at
         FROM outbox
        WHERE published_at IS NULL
          AND abandoned_at IS NULL
          AND ($2::uuid IS NULL OR tenant_id = $2)
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [batch, onlyTenant ?? null],
    );
    for (const row of r.rows) {
      const body = { tenantId: row.tenant_id, attempt: 0, payload: row.payload };
      // Confirm-then-mark: `publish` alone reports only that the bytes were
      // buffered locally. Marking a row published before the broker has
      // confirmed loses the invoice if RabbitMQ dies in that window — the exact
      // failure the outbox exists to prevent.
      const ok = await broker.publishConfirmed(row.exchange, row.routing_key, body);
      if (ok) {
        await c.query('UPDATE outbox SET published_at = now() WHERE id = $1', [row.id]);
        stats.published++;
      } else {
        /**
         * A row the broker will never accept — an unknown exchange, a payload
         * it refuses — must not block every row behind it. After MAX_ATTEMPTS
         * it is marked published so the queue drains, and logged loudly with
         * its identifiers so an operator can recover it.
         *
         * Marking it published is a deliberate trade: the alternative is a
         * permanently stuck relay, which loses EVERY subsequent invoice rather
         * than one. The audit log and this error line are the recovery path.
         */
        const attempts = row.attempts + 1;
        const ageMs = Date.now() - new Date(row.created_at).getTime();
        if (attempts >= MAX_RELAY_ATTEMPTS && ageMs >= MIN_RELAY_AGE_MS) {
          /**
           * Marked `abandoned_at`, NOT `published_at`.
           *
           * Claiming a row was published when it never reached the broker is a
           * lie the purge worker then acts on — it deletes by `published_at`,
           * so the invoice disappears with only a log line as evidence. A
           * distinct column keeps the row out of the relay's way while
           * preserving it for recovery.
           */
          await c.query(
            `UPDATE outbox SET attempts = $2, abandoned_at = now() WHERE id = $1`,
            [row.id, attempts]);
          log.error(
            { outboxId: row.id, tenantId: row.tenant_id, exchange: row.exchange,
              routingKey: row.routing_key, attempts },
            'outbox row ABANDONED after repeated publish failures — it is NOT on the queue ' +
            'and NOT published. The row is preserved (abandoned_at) for recovery; the relay ' +
            'continues so other invoices are not blocked. Investigate the exchange and key.',
          );
          stats.abandoned++;
          await alert({ tenantId: null, kind: 'system.outbox_abandoned', channel: null,
            detail: { outboxId: String(row.id), tenantId: row.tenant_id, exchange: row.exchange,
                      routingKey: row.routing_key, attempts } });
        } else {
          await c.query('UPDATE outbox SET attempts = $2 WHERE id = $1', [row.id, attempts]);
        }
        stats.failed++;
      }
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    log.error({ err: e }, 'outbox drain failed');
    throw e;
  } finally {
    c.release();
  }
  return stats;
}

/**
 * Long-running relay loop. A separate process from the API and workers.
 *
 * Polls every `intervalMs`, and additionally LISTENs for `passo_outbox` so a
 * new row is picked up immediately rather than after up to a full tick
 * (QUEUE-008).
 *
 * The NOTIFY is a LATENCY optimisation and nothing more. Postgres does not
 * deliver a notification to a disconnected listener and does not queue it for
 * one, so a relay that was reconnecting when the row landed would never hear
 * about it. The poll is the correctness guarantee; removing the trigger
 * entirely must change only latency.
 */
export function startRelay(
  db: Db, broker: Broker, log: Logger, intervalMs = 200,
): { stop: () => void } {
  let stopped = false;
  let wake: (() => void) | null = null;

  /** Resolves on a NOTIFY, or after the interval — whichever comes first. */
  const waitForWork = () => new Promise<void>((resolve) => {
    const timer = setTimeout(() => { wake = null; resolve(); }, intervalMs);
    wake = () => { clearTimeout(timer); wake = null; resolve(); };
  });

  /**
   * A DEDICATED connection: a listening session cannot be returned to the pool
   * (it would deliver another caller's notifications), and it must survive the
   * whole relay lifetime.
   */
  const listen = async (): Promise<void> => {
    while (!stopped) {
      let client;
      try {
        client = await db.connect();
        client.on('notification', () => wake?.());
        await client.query('LISTEN passo_outbox');
        log.info('relay listening for outbox notifications');
        // Hold the connection until it errors or the relay stops.
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (stopped) { clearInterval(check); resolve(); }
          }, 500);
          client!.on('error', (err: Error) => {
            log.warn({ err }, 'outbox listener connection lost — polling continues');
            clearInterval(check); resolve();
          });
        });
      } catch (err) {
        log.warn({ err }, 'could not establish the outbox listener — polling only');
      } finally {
        // release(true) DESTROYS the connection rather than returning a session
        // that is still in LISTEN state to the pool.
        try { client?.release(true); } catch { /* already gone */ }
      }
      if (!stopped) await new Promise((r) => setTimeout(r, 2_000));
    }
  };

  const tick = async () => {
    while (!stopped) {
      try {
        const s = await drainOutbox(db, broker, log);
        if (s.published === 0) await waitForWork();
      } catch {
        await new Promise((r) => setTimeout(r, intervalMs * 5));
      }
    }
  };

  void tick();
  void listen();
  return { stop: () => { stopped = true; wake?.(); } };
}
