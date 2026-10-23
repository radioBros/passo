import { describe, it, expect } from 'vitest';
import { STATE, TERMINAL, applyNotification, canRetry } from '../../src/domain/submission/state.ts';
import { isValidProgressivo } from '../../src/domain/submission/progressivo.ts';

describe('submission state machine', () => {
  it('RC delivers, terminally', () => {
    expect(applyNotification(STATE.transmitted, 'RC')).toEqual({ next: 'delivered', terminal: true });
  });
  it('NS rejects, terminally — the invoice is legally NOT issued', () => {
    expect(applyNotification(STATE.transmitted, 'NS')).toEqual({ next: 'rejected', terminal: true });
  });
  it('MC is NOT terminal and NOT a failure — SdI is still delivering', () => {
    expect(applyNotification(STATE.transmitted, 'MC')).toEqual({ next: 'awaiting_delivery', terminal: false });
  });
  it('DT stands as delivered (PA silence)', () => {
    expect(applyNotification(STATE.delivered, 'DT').next).toBe('delivered');
  });
  it('NE distinguishes EC01 accept from EC02 reject', () => {
    expect(applyNotification(STATE.delivered, 'NE', 'EC01').next).toBe('accepted_by_pa');
    expect(applyNotification(STATE.delivered, 'NE', 'EC02').next).toBe('rejected_by_pa');
  });
});

describe('retry guard — prevents duplicate submissions to the tax authority', () => {
  it('NEVER retries an NS', () => {
    expect(canRetry(STATE.rejected)).toEqual({ ok: false, reason: 'ERR_CONFLICT_NS_RETRY' });
  });
  it('NEVER retries an MC — SdI is already retrying delivery', () => {
    expect(canRetry(STATE.awaitingDelivery)).toEqual({ ok: false, reason: 'ERR_CONFLICT_MC_RETRY' });
  });
  it('refuses every terminal state the vendor has seen', () => {
    for (const s of TERMINAL) if (s !== STATE.failed) expect(canRetry(s).ok, s).toBe(false);
  });
  /** `failed` never reached SdI: resending cannot duplicate anything. */
  it('allows retrying a FAILED submission', () => {
    expect(canRetry(STATE.failed).ok).toBe(true);
  });
  /** The vendor HAS a transmitted invoice; resending would duplicate it. */
  it('REFUSES a transmitted submission', () => {
    expect(canRetry(STATE.transmitted)).toEqual({ ok: false, reason: 'ERR_CONFLICT_TERMINAL' });
  });
  it('allows retry from a transient state', () => {
    expect(canRetry(STATE.transmitting).ok).toBe(true);
  });
});

describe('ProgressivoInvio', () => {
  it('accepts up to 10 chars (String10Type), not 5', () => {
    expect(isValidProgressivo('ABCDE12345')).toBe(true);
    expect(isValidProgressivo('00001')).toBe(true);
    expect(isValidProgressivo('ABCDE123456')).toBe(false);
    expect(isValidProgressivo('')).toBe(false);
  });
});

/**
 * Terminal-state precedence.
 *
 * SdI receipts arrive out of order, are redelivered by vendors, and are re-read
 * from a PEC mailbox on every poll. Before this, `applyNotification` accepted
 * `current` and ignored it — so a stale RC could overwrite an NS and tell a CRM
 * its invoice was ACCEPTED when the tax authority had rejected it. The CRM
 * would then never issue the replacement the law requires.
 */
describe('terminal precedence', () => {
  it('a REJECTION is absorbing — nothing un-rejects an invoice', () => {
    for (const t of ['RC', 'DT', 'MC', 'AT']) {
      expect(applyNotification(STATE.rejected, t).next, t).toBe(STATE.rejected);
    }
  });

  it('a late RC does NOT overwrite a rejection', () => {
    // The exact scenario: NS lands, then a redelivered RC arrives.
    expect(applyNotification(STATE.rejected, 'RC')).toEqual({
      next: STATE.rejected, terminal: true,
    });
  });

  it('a duplicate RC after delivery is a no-op', () => {
    expect(applyNotification(STATE.delivered, 'RC').next).toBe(STATE.delivered);
  });

  it('an NS still wins over an apparent delivery — the authority corrects us', () => {
    expect(applyNotification(STATE.delivered, 'NS').next).toBe(STATE.rejected);
  });

  /**
   * The genuine B2G progression: SdI delivers (RC), then the PA accepts or
   * refuses (NE). Blocking this would freeze every public-administration
   * invoice at `delivered`.
   */
  it('an NE ADVANCES a delivered invoice — that is the B2G flow', () => {
    expect(applyNotification(STATE.delivered, 'NE', 'EC01').next).toBe(STATE.acceptedByPa);
    expect(applyNotification(STATE.delivered, 'NE', 'EC02').next).toBe(STATE.rejectedByPa);
  });

  it('an MC cannot pull a delivered invoice backwards', () => {
    // MC is non-terminal, but arriving after delivery it is stale.
    expect(applyNotification(STATE.delivered, 'MC').next).toBe(STATE.delivered);
  });

  it('a non-terminal state still advances normally', () => {
    expect(applyNotification(STATE.transmitted, 'RC').next).toBe(STATE.delivered);
    expect(applyNotification(STATE.awaitingDelivery, 'RC').next).toBe(STATE.delivered);
  });
});
