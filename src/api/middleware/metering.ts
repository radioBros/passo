import type { Request, Response, NextFunction } from 'express';
import type { Db } from '../../infra/db/pool.ts';
import { withTx } from '../../infra/db/pool.ts';
import type { Logger } from '../../shared/logger.ts';

/**
 * Buffered usage metering (KEY-017).
 *
 * Written from an in-process buffer, never synchronously on the request path.
 * A per-request INSERT would make metering the slowest thing in a handler that
 * otherwise does one indexed read — and it would put invoice submission behind
 * a write nobody is waiting for.
 *
 * The trade is explicit: a hard crash loses at most one buffer. Usage data is
 * operational, not fiscal — nothing legal depends on it, and the audit log
 * (which is fiscal) is written transactionally and separately.
 */

export interface UsageRow {
  tenantId: string; keyId: string | null; route: string;
  method: string; status: number; durationMs: number;
}

const FLUSH_ROWS = 500;
const FLUSH_MS = 1_000;

export class UsageMeter {
  private buffer: UsageRow[] = [];
  private timer: NodeJS.Timeout | undefined;
  private flushing = false;

  // Expanded rather than parameter properties: Node's strip-only TypeScript
  // mode does not support them (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  private readonly db: Db;
  private readonly log: Logger;

  constructor(db: Db, log: Logger) {
    this.db = db;
    this.log = log;
  }

  record(row: UsageRow): void {
    this.buffer.push(row);
    // Bound the buffer: an unbounded one turns a database outage into a memory
    // leak that eventually kills the process serving invoices.
    if (this.buffer.length >= FLUSH_ROWS) { void this.flush(); return; }
    this.timer ??= setTimeout(() => { void this.flush(); }, FLUSH_MS).unref();
  }

  async flush(): Promise<number> {
    if (this.flushing || this.buffer.length === 0) return 0;
    this.flushing = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const batch = this.buffer;
    this.buffer = [];

    try {
      await withTx(this.db, async (tx) => {
        // One batch spans tenants, so this cannot run in a tenant context.
        await tx.query('SET LOCAL ROLE passo_relay');
        // A single multi-row INSERT: 500 round-trips would defeat the buffering.
        const values: unknown[] = [];
        const tuples = batch.map((r, i) => {
          const b = i * 6;
          values.push(r.tenantId, r.keyId, r.route, r.method, r.status, r.durationMs);
          return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`;
        });
        await tx.query(
          `INSERT INTO api_key_usage (tenant_id, key_id, route, method, status, duration_ms)
           VALUES ${tuples.join(',')}`, values);
      });
      return batch.length;
    } catch (err) {
      // Dropped, deliberately: re-queueing a failing batch would grow the
      // buffer without bound while the database is unavailable.
      this.log.warn({ err, dropped: batch.length }, 'usage metering flush failed');
      return 0;
    } finally {
      this.flushing = false;
    }
  }

  /** Flush on shutdown so the last second of traffic is not lost. */
  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.flush();
  }
}

export function meter(m: UsageMeter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = Date.now();
    res.on('finish', () => {
      // Only authenticated traffic: an unauthenticated request has no tenant to
      // attribute, and attributing it to nobody would skew every aggregate.
      if (!req.tenantId) return;
      m.record({
        tenantId: req.tenantId,
        keyId: req.keyId ?? null,
        // The ROUTE, not the URL: `/invoices/:id` rather than a distinct row
        // per submission id, which would make the table as large as the traffic.
        route: req.route?.path ?? req.path.replace(/\/[0-9a-f-]{36}/gi, '/:id'),
        method: req.method,
        status: res.statusCode,
        durationMs: Date.now() - started,
      });
    });
    next();
  };
}
