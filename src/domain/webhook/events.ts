import { z } from 'zod';

/**
 * The webhook event catalogue (WH-003).
 *
 * Event names were previously string literals scattered across the notification
 * service, the workers and the admin routes. Nothing connected them, so a typo
 * in one place produced a subscription that silently never fired — the failure
 * mode being *no delivery at all*, which looks identical to "nothing happened
 * yet" and is therefore invisible until someone asks why a receipt never
 * arrived.
 *
 * One frozen list, validated at subscription time: an unknown event name is
 * refused when it is registered rather than discovered months later.
 */
export const WEBHOOK_EVENTS = [
  /** Accepted by PASSO and durably queued. Not yet at SdI. */
  'invoice.submitted',
  /** Handed to the channel; AT received. In SdI's hands. */
  'invoice.transmitted',
  /** RC or DT — delivered to the recipient, or terms expired. Terminal. */
  'invoice.delivered',
  /** NS — TERMINAL. The invoice is legally NOT issued; a new one is required. */
  'invoice.rejected',
  /** MC — NOT a failure. The invoice IS issued; SdI is still delivering. */
  'invoice.exception',
  /** AT — transmitted but SdI could not deliver within its window. */
  'invoice.transmitted_undelivered',
  /** NE / EC01 — the public administration accepted it (B2G only). */
  'invoice.accepted_by_pa',
  /** NE / EC02 — the public administration rejected it (B2G only). */
  'invoice.rejected_by_pa',
  /** A state change with no more specific event. */
  'invoice.status_changed',
  /** No receipt arrived within the expected window. */
  'invoice.timeout',
  /** The pipeline could not process it; the payload never reached SdI. */
  'submission.failed',
  /** An API key is within its expiry warning window. */
  'apikey.expiring',
  /** An API key has expired and no longer authenticates. */
  'apikey.expired',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const EVENT_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENTS);
export const isWebhookEvent = (v: string): v is WebhookEvent => EVENT_SET.has(v);

/**
 * What each event means, and — more importantly — what the CRM should do.
 *
 * `action` is the field that prevents the two most expensive mistakes in this
 * domain: auto-retrying an NS (which submits a duplicate to the tax authority)
 * and treating an MC as a failure (the invoice IS issued).
 */
export interface EventMeaning {
  event: WebhookEvent;
  terminal: boolean;
  /** True when the invoice is legally issued at this point. */
  legallyIssued: boolean;
  description: string;
  action: string;
}

export const EVENT_CATALOGUE: Record<WebhookEvent, EventMeaning> = {
  'invoice.submitted': {
    event: 'invoice.submitted', terminal: false, legallyIssued: false,
    description: 'PASSO accepted the invoice and queued it durably. It has not reached SdI yet.',
    action: 'none_required',
  },
  'invoice.transmitted': {
    event: 'invoice.transmitted', terminal: false, legallyIssued: false,
    description: 'The invoice reached SdI. A receipt will follow.',
    action: 'await_receipt',
  },
  'invoice.delivered': {
    event: 'invoice.delivered', terminal: true, legallyIssued: true,
    description: 'RC or DT: SdI delivered the invoice, or the delivery terms expired in your favour.',
    action: 'none_required',
  },
  'invoice.rejected': {
    event: 'invoice.rejected', terminal: true, legallyIssued: false,
    description:
      'NS: SdI REJECTED the invoice. It is legally NOT issued. This is terminal — the same ' +
      'invoice can never be accepted.',
    action: 'issue_new_invoice',
  },
  'invoice.exception': {
    event: 'invoice.exception', terminal: false, legallyIssued: true,
    description:
      'MC: SdI could not deliver to the recipient yet and is still trying. The invoice IS ' +
      'legally issued. This is NOT a failure.',
    action: 'none_required',
  },
  'invoice.transmitted_undelivered': {
    event: 'invoice.transmitted_undelivered', terminal: true, legallyIssued: true,
    description:
      'AT: SdI could not deliver within its window. The invoice IS issued; you must make it ' +
      'available to the recipient by other means.',
    action: 'notify_recipient',
  },
  'invoice.accepted_by_pa': {
    event: 'invoice.accepted_by_pa', terminal: true, legallyIssued: true,
    description: 'NE/EC01: the public administration accepted the invoice (B2G only).',
    action: 'none_required',
  },
  'invoice.rejected_by_pa': {
    event: 'invoice.rejected_by_pa', terminal: true, legallyIssued: true,
    description:
      'NE/EC02: the public administration rejected the invoice (B2G only). The invoice was ' +
      'still legally issued — this is a commercial rejection, not a fiscal one.',
    action: 'contact_recipient',
  },
  'invoice.status_changed': {
    event: 'invoice.status_changed', terminal: false, legallyIssued: false,
    description: 'A state change with no more specific event.',
    action: 'inspect_status',
  },
  'invoice.timeout': {
    event: 'invoice.timeout', terminal: false, legallyIssued: false,
    description: 'No receipt arrived within the expected window. The invoice may still be in flight.',
    action: 'inspect_status',
  },
  'submission.failed': {
    event: 'submission.failed', terminal: true, legallyIssued: false,
    description: 'PASSO could not process the submission. It never reached SdI.',
    action: 'fix_and_resubmit',
  },
  'apikey.expiring': {
    event: 'apikey.expiring', terminal: false, legallyIssued: false,
    description: 'An API key is approaching its expiry date.',
    action: 'rotate_key',
  },
  'apikey.expired': {
    event: 'apikey.expired', terminal: true, legallyIssued: false,
    description: 'An API key has expired and no longer authenticates.',
    action: 'rotate_key',
  },
};

/**
 * FatturaPA money is a PATTERNED STRING, never a number.
 *
 * `1000` is schema-invalid where `"1000.00"` is valid, and a JSON number cannot
 * express the difference — `1000.00` parses to `1000` and serialises back
 * without the decimals. Every monetary field in a webhook payload is therefore
 * typed as a string here, so a receiver that round-trips our payload cannot
 * silently destroy the format.
 */
export const DecimalString = z.string().regex(
  /^-?\d{1,11}\.\d{2}$/,
  'must be a decimal string with exactly two places, e.g. "1000.00" — never a JSON number',
);

/** The envelope every webhook shares. */
export const EventEnvelope = z.object({
  eventId: z.string().min(1),
  eventType: z.enum(WEBHOOK_EVENTS),
  apiVersion: z.string().min(1),
  createdAt: z.string().min(1),
  tenantId: z.string().uuid(),
  data: z.record(z.string(), z.unknown()),
});

export type EventEnvelopeType = z.infer<typeof EventEnvelope>;

/** One SdI rejection reason, as it appears inside `invoice.rejected`. */
export const RejectionError = z.object({
  code: z.string(),
  description: z.string(),
  gloss: z.string(),
  remedy: z.string(),
  guidance: z.string(),
  known: z.boolean(),
  sdiDescription: z.string().nullable(),
});

/** The `data` block for an invoice-scoped event. */
export const InvoiceEventData = z.object({
  submissionId: z.string().nullable(),
  notificationType: z.string().optional(),
  // NS only — the two flags integrators most often miss.
  retryable: z.boolean().optional(),
  requiresNewSubmission: z.boolean().optional(),
  errors: z.array(RejectionError).optional(),
  // MC only.
  legallyIssued: z.boolean().optional(),
  action: z.string().optional(),
});

export const API_VERSION = 'v1';

/**
 * Validate a subscription's event list, naming the valid set on failure.
 *
 * A subscription to a misspelled event is silently inert — it simply never
 * fires — so this refuses at registration time, when the author is present to
 * read the error.
 */
export function assertValidEvents(events: readonly string[]): WebhookEvent[] {
  const bad = events.filter((e) => !isWebhookEvent(e));
  if (bad.length > 0) {
    throw new Error(
      `unknown webhook event(s): ${bad.join(', ')}. Valid events: ${WEBHOOK_EVENTS.join(', ')}`,
    );
  }
  return [...events] as WebhookEvent[];
}
