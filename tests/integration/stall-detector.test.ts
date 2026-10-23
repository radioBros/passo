import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHarness, seedTenant, validInvoice, type Harness } from '../helpers/harness.ts';
import { withTx, withTenant } from '../../src/infra/db/pool.ts';
import { submitInvoice } from '../../src/domain/submission/service.ts';
import { MockChannel } from '../../src/infra/channels/mock.ts';
import { detectStalls, POLLER_STALE_MINUTES, MC_WINDOW_DAYS } from '../../src/workers/stall-detector.ts';
import { logger } from '../../src/shared/logger.ts';

/**
 * NOTIF-023 — stalled-submission detection.
 *
 * The criterion is specific about the hard part: a stopped poller must be
 * caught within one alerting window, a genuinely slow SdI must NOT raise a
 * false alarm, and the alert has to name the likely cause. Those are three
 * different assertions, so they get three different tests.
 */
let h: Harness;
beforeAll(() => { h = createHarness(); });
afterAll(async () => { await h.close(); });

const setPollAt = (sql: string) => withTx(h.db, async (tx) => {
  await tx.query('SET LOCAL ROLE passo_relay');
  await tx.query(`UPDATE channel_health SET last_poll_at = ${sql} WHERE channel = 'pec'`);
});

/** Capture what the detector logs, to assert the alert names its cause. */
const capture = () => {
  const lines: Array<{ level: string; msg: string }> = [];
  const rec = (level: string) => (_o: unknown, msg?: string) =>
    { lines.push({ level, msg: msg ?? String(_o) }); };
  return {
    lines,
    log: { ...logger, error: rec('error'), warn: rec('warn'), info: rec('info') } as never,
  };
};


/**
 * Create a submission through the real path, then age it. Hand-writing the row
 * would drift from the schema and prove nothing about what the app produces.
 */
const agedSubmission = async (channel: string, age: string, state = 'transmitted') => {
  const v = await seedTenant(h);
  const r = await submitInvoice(h.db, h.keys, validInvoice(), {
    tenantId: v.tenantId, sellerId: v.sellerId, channel: new MockChannel(),
  });
  await withTenant(h.db, v.tenantId, (tx) => tx.query(
    `UPDATE sdi_submissions
        SET state = $2, channel = $3, submitted_at = now() - $4::interval
      WHERE id = $1`,
    [r.submissionId, state, channel, age]));
  return r.submissionId;
};

beforeEach(async () => { await setPollAt('now()'); });

describe('stalled-submission detection', () => {
  it('a HEALTHY poller raises nothing', async () => {
    const c = capture();
    const r = await detectStalls(h.db, c.log);
    expect(r.ingressStalled).toHaveLength(0);
  });

  it('detects a STOPPED poller within one alerting window', async () => {
    await setPollAt(`now() - interval '${POLLER_STALE_MINUTES + 5} minutes'`);
    const c = capture();
    const r = await detectStalls(h.db, c.log);
    expect(r.ingressStalled.map((s) => s.channel)).toContain('pec');
  });

  it('names the likely cause — a PASSO-side failure, not SdI', async () => {
    await setPollAt(`now() - interval '${POLLER_STALE_MINUTES + 5} minutes'`);
    const c = capture();
    await detectStalls(h.db, c.log);
    const alert = c.lines.find((l) => l.level === 'error');
    expect(alert?.msg).toMatch(/INGRESS STALLED/);
    expect(alert?.msg).toMatch(/PASSO-side failure, not SdI being slow/);
    expect(alert?.msg).toMatch(/Check the poller process/);
  });

  it('a poller that has NEVER run counts as stalled, not as healthy', async () => {
    await setPollAt('NULL');
    const r = await detectStalls(h.db, capture().log);
    expect(r.ingressStalled.map((s) => s.channel)).toContain('pec');
  });

  /**
   * The false-alarm case. SdI may take up to 5 days for a B2B delivery, so a
   * recently transmitted submission is NOT evidence of a problem — reporting it
   * would train operators to ignore the alert that matters.
   */
  it('a RECENT unanswered submission is NOT reported — SdI is allowed to be slow', async () => {
    await agedSubmission('pec', '2 hours');
    const r = await detectStalls(h.db, capture().log);
    expect(r.slowSubmissions.find((s) => s.channel === 'pec')).toBeUndefined();
  });

  it('reports a LONG-waiting submission as a warning, never as an error', async () => {
    await agedSubmission('mock', '10 hours');
    const c = capture();
    const r = await detectStalls(h.db, c.log);
    expect(r.slowSubmissions.map((s) => s.channel)).toContain('mock');
    // Slowness is expected behaviour: it must not be logged at error level,
    // which is reserved for "our ingress is broken".
    const slowLine = c.lines.find((l) => l.msg.includes('awaited a receipt'));
    expect(slowLine?.level).toBe('warn');
    expect(slowLine?.msg).toMatch(/SdI being slow/);
  });

  it('a TERMINAL submission is never counted as waiting', async () => {
    await agedSubmission('mock', '100 days', 'delivered');
    const r = await detectStalls(h.db, capture().log);
    const mock = r.slowSubmissions.find((s) => s.channel === 'mock');
    // Only genuinely waiting rows count; a delivered one must not inflate this.
    if (mock) expect(mock.oldestHours).toBeLessThan(100 * 24);
  });
});

/**
 * QUEUE-020 — MC as a scheduled RE-CHECK, never a retry.
 *
 * SdI attempts delivery for up to 30 days then issues an AT. An MC still
 * sitting here past that window means the AT never arrived — the receipt was
 * lost, not that SdI is still trying.
 *
 * The invoice IS legally issued throughout, so this is a reconciliation gap
 * rather than a failure to fix. Resubmitting would duplicate a legally issued
 * document at the tax authority.
 */
describe('MC re-check', () => {
  it('does NOT report an MC still inside SdI delivery window', async () => {
    await agedSubmission('mock', '3 days', 'awaiting_delivery');
    const r = await detectStalls(h.db, capture().log);
    /**
     * The report aggregates across tenants, and a sibling test deliberately
     * ages a submission past the window — so assert on the AGE rather than on
     * an empty list: a 3-day MC must never be what makes `oldestDays` exceed
     * the threshold.
     */
    for (const e of r.mcExpired) expect(e.oldestDays).toBeGreaterThan(MC_WINDOW_DAYS);
  });

  it('reports an MC past the 30-day window', async () => {
    await agedSubmission('mock', '40 days', 'awaiting_delivery');
    const r = await detectStalls(h.db, capture().log);
    expect(r.mcExpired.length).toBeGreaterThan(0);
    expect(r.mcExpired[0]!.oldestDays).toBeGreaterThan(MC_WINDOW_DAYS);
  });

  it('says DO NOT RESUBMIT — the invoice is already legally issued', async () => {
    await agedSubmission('mock', '40 days', 'awaiting_delivery');
    const c = capture();
    await detectStalls(h.db, c.log);
    const line = c.lines.find((l) => l.msg.includes('awaiting delivery for over'));
    expect(line?.msg).toMatch(/do NOT resubmit/i);
    expect(line?.msg).toMatch(/ARE legally issued/);
    // Reported as a reconciliation gap, not an error to fix.
    expect(line?.level).toBe('warn');
  });
});
