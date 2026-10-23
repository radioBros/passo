import { describe, it, expect } from 'vitest';
import { milestoneChannel, SYNC_MILESTONES } from '../../src/infra/queue/milestone.ts';

/**
 * Sync-mode milestone semantics (API-014 / API-015).
 *
 * Sync mode was advertised and, in production, inert: `waitForMilestone` was
 * declared on the deps interface and never supplied, so every `mode: "sync"`
 * request silently fell back to 202. These tests pin the two rules that make
 * the feature safe rather than merely working.
 */
describe('sync milestones', () => {
  it('gives each submission its own channel — no fan-out, no filtering', () => {
    expect(milestoneChannel('a')).not.toBe(milestoneChannel('b'));
    expect(milestoneChannel('abc')).toContain('abc');
  });

  /**
   * MC delivery retry legally runs for days and DT has a 15-day window, so a
   * sync wait on those is a hang, not a wait. Only milestones reachable within
   * an HTTP timeout may appear here.
   */
  it('NEVER waits on RC, MC or DT — no HTTP timeout can represent them', () => {
    for (const forbidden of ['delivered', 'awaiting_delivery', 'decorrenza_termini']) {
      expect(SYNC_MILESTONES.has(forbidden), forbidden).toBe(false);
    }
  });

  it('waits only on outcomes an HTTP caller can actually receive', () => {
    expect(SYNC_MILESTONES.has('transmitted')).toBe(true);
    expect(SYNC_MILESTONES.has('failed')).toBe(true);
  });
});
