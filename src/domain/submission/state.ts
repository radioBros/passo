/**
 * Submission state machine.
 *
 * Derived from the NINE SdI notification types. Six address the transmitter and
 * drive this machine; MT/EC/SE belong to the inbound-reception flow (v2).
 */
export const STATE = {
  queued: 'queued',
  transforming: 'transforming',
  generating: 'generating',
  signing: 'signing',
  transmitting: 'transmitting',
  transmitted: 'transmitted',                 // sync mode resolves HERE
  awaitingDelivery: 'awaiting_delivery',      // MC
  delivered: 'delivered',                     // RC, or DT (PA silence)
  undeliveredAttested: 'undelivered_attested',// AT
  acceptedByPa: 'accepted_by_pa',             // NE, outcome EC01
  rejectedByPa: 'rejected_by_pa',             // NE, outcome EC02
  rejected: 'rejected',                       // NS — terminal, needs a NEW invoice
  failed: 'failed',                           // internal, never reached SdI
} as const;
export type State = (typeof STATE)[keyof typeof STATE];

export const TERMINAL: ReadonlySet<State> = new Set([
  STATE.delivered, STATE.rejected, STATE.acceptedByPa,
  STATE.rejectedByPa, STATE.undeliveredAttested, STATE.failed,
]);

/**
 * What each transmitter notification does to the state.
 *
 * `current` is CONSULTED, not ignored. SdI receipts arrive out of order, are
 * redelivered by vendors, and are re-read from a PEC mailbox — so a late or
 * repeated RC must not overwrite a terminal outcome that already happened.
 *
 * The case that matters: an NS means the invoice is legally NOT issued. If a
 * stale RC could move it to `delivered`, the CRM would be told an invoice was
 * accepted when the tax authority rejected it — and would never issue the
 * replacement the law requires.
 */
export function applyNotification(
  current: State, type: string, esito?: string | null,
): { next: State; terminal: boolean } {
  /**
   * A REJECTION is absorbing. Nothing SdI sends afterwards can un-reject an
   * invoice: the document was refused and a new one must be issued.
   */
  if (current === STATE.rejected) {
    return { next: STATE.rejected, terminal: true };
  }

  /**
   * Any other terminal state yields only to a rejection or a PA outcome.
   *
   * A duplicate RC after a delivered invoice is a no-op. An NS arriving later
   * is the tax authority correcting us and wins. An NE is the genuine B2G
   * continuation — SdI delivers (RC), then the PA accepts or refuses — so it
   * must be allowed to advance a delivered invoice.
   */
  if (TERMINAL.has(current) && type !== 'NS' && type !== 'NE') {
    return { next: current, terminal: true };
  }

  switch (type) {
    case 'RC': return { next: STATE.delivered, terminal: true };
    case 'NS': return { next: STATE.rejected, terminal: true };
    case 'MC': return { next: STATE.awaitingDelivery, terminal: false };
    case 'AT': return { next: STATE.undeliveredAttested, terminal: true };
    case 'DT': return { next: STATE.delivered, terminal: true };
    case 'NE':
      return esito === 'EC02'
        ? { next: STATE.rejectedByPa, terminal: true }
        : { next: STATE.acceptedByPa, terminal: true };
    default:
      return { next: current, terminal: TERMINAL.has(current) };
  }
}

/**
 * Retry eligibility. This function is the guard that stops PASSO submitting
 * duplicates to the tax authority.
 */
/**
 * States from which an invoice may be (re)sent: those where the vendor does
 * NOT have it. `failed` never reached SdI; `transmitting` is retried only by
 * an operator who has confirmed with the vendor that it never arrived (an
 * ambiguous timeout leaves it there on purpose). `transmitted` and everything
 * after it is refused — the vendor HAS it, and resending duplicates it.
 */
export const RETRYABLE_STATES: ReadonlySet<State> = new Set([
  STATE.queued, STATE.transforming, STATE.generating, STATE.signing,
  STATE.transmitting, STATE.failed,
]);

export function canRetry(state: State): { ok: boolean; reason?: string } {
  if (state === STATE.rejected) {
    return { ok: false, reason: 'ERR_CONFLICT_NS_RETRY' };
  }
  if (state === STATE.awaitingDelivery) {
    return { ok: false, reason: 'ERR_CONFLICT_MC_RETRY' };
  }
  if (!RETRYABLE_STATES.has(state)) {
    return { ok: false, reason: 'ERR_CONFLICT_TERMINAL' };
  }
  return { ok: true };
}
