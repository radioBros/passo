import type { ParsedNotification } from '../../domain/notification/parser.ts';

/**
 * One interface, four implementations. Vendor differences stay inside adapters
 * so the pipeline never branches on channel.
 */
export interface SubmitInput {
  tenantId: string;
  submissionId: string;
  xml: string;
  filename: string;
  signed: boolean;
}

export interface SubmitResult {
  /** Vendor-side handle, when the vendor issues one synchronously. */
  channelRef?: string;
  /** SdI's own identifier, when available immediately. */
  identificativoSdI?: string;
  /** PEC: the Message-ID of the sent mail — correlates receipts back. */
  pecMessageId?: string;
  acceptedAt: Date;
}

export interface ChannelCapabilities {
  /**
   * Can the channel EVER sign on our behalf? PEC cannot. This is a property of
   * the channel, not of a tenant's configuration — whether a given submission
   * actually gets signed is `willSign(config)`.
   */
  serverSideSigning: boolean;
  /** Webhook push (API vendors) vs polling (PEC/IMAP). */
  pushNotifications: boolean;
  maxMessageBytes: number;
}

export interface SdiChannelAdapter {
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  submit(input: SubmitInput, config: Record<string, unknown>): Promise<SubmitResult>;

  /**
   * Will THIS tenant's configuration make the channel apply a signature?
   *
   * Distinct from `capabilities.serverSideSigning`: a vendor that can sign only
   * does so when the tenant enabled it. Gating B2G on the capability alone let
   * an unsigned FPA12 invoice through on a vendor channel with signing off —
   * and SdI answers that with an NS, which is terminal.
   */
  willSign(config: Record<string, unknown>): boolean;

  /** API vendors: fetch the receipts for one submission by the vendor's handle. */
  fetchReceipts?(
    config: Record<string, unknown>, channelRef: string,
    /** `withIds: false` skips the (possibly billed) lookup of SdI's own id. */
    opts?: { withIds?: boolean },
  ): Promise<VendorReceipts>;
  /** Poll-based channels implement this. */
  poll?(config: Record<string, unknown>): Promise<PollResult>;

  /**
   * Acknowledge notifications the caller has DURABLY persisted.
   *
   * Split from `poll` deliberately: the mailbox is the only copy of a legal
   * receipt, so a message may only be marked read once it is safely stored.
   * Acknowledging inside `poll` would lose a receipt on any crash between
   * fetch and persist.
   */
  acknowledge?(config: Record<string, unknown>, receipts: string[]): Promise<void>;

  /**
   * Is this channel usable right now (SDI-020)?
   *
   * Credentials and reachability, NOT a test submission — a health check that
   * submits would put junk in front of the tax authority every time an operator
   * looked at a dashboard.
   *
   * Deliberately absent from `/health/ready`: a vendor outage must not take
   * PASSO out of rotation, because Postgres is the durability boundary and
   * queued invoices submit when the vendor returns.
   */
  health?(config: Record<string, unknown>): Promise<ChannelHealth>;
}

export interface ChannelHealth {
  ok: boolean;
  /** What was actually checked, so a green result is interpretable. */
  checked: string;
  latencyMs?: number;
  error?: string;
}

/**
 * A polled notification plus the channel's own handle for it (an IMAP UID for
 * PEC). The handle is opaque to the domain and travels back to `acknowledge`.
 */
export interface PolledNotification extends ParsedNotification {
  receiptHandle?: string;
}

/**
 * A fetched message PASSO cannot process: unparseable MIME, an oversized
 * message, or an XML attachment that is not a notification.
 *
 * It is REPORTED rather than skipped. The caller quarantines `raw` durably and
 * only then acknowledges `receiptHandle` — so the message is neither lost (it
 * may be a legal receipt) nor re-fetched and re-parsed on every poll forever.
 */
export interface PoisonMessage {
  receiptHandle: string;
  reason: string;
  raw: string;
  filename?: string;
}

/**
 * Receipts for ONE submission, fetched from an API vendor by its own handle.
 *
 * Push-only delivery means a missed webhook is a lost receipt; fetching by the
 * vendor's handle is both the polling fallback and how a webhook is verified —
 * its body is never trusted, PASSO re-reads the receipt from the vendor.
 */
export interface VendorReceipts {
  /** SdI's IdentificativoSdI as the vendor reports it, once known. */
  identificativoSdI?: string;
  /** The file name SdI saw — the vendor's, which can differ from PASSO's. */
  sdiFileName?: string;
  notifications: ParsedNotification[];
  poison: Array<{ reason: string; raw: string }>;
}

export interface PollResult {
  notifications: PolledNotification[];
  poison: PoisonMessage[];
}

/**
 * Did the invoice reach the vendor?
 *
 * `not_sent` — certainly not: the vendor answered with a refusal (402, 429,
 *   503…), or the connection was never established. Safe to send again.
 * `unknown` — maybe: a timeout or a connection dropped mid-request. The
 *   vendor may have accepted it. Sending again can create a DUPLICATE
 *   invoice at SdI — OpenAPI.it renames the file, so SdI's duplicate-name
 *   check would not catch it — so such a failure is never retried
 *   automatically; it is surfaced for an operator to reconcile.
 */
export type Delivery = 'not_sent' | 'unknown';

export class ChannelError extends Error {
  readonly retryable: boolean;
  readonly code: string | undefined;
  readonly delivery: Delivery;
  constructor(message: string, retryable: boolean, code?: string, delivery?: Delivery) {
    super(message);
    this.retryable = retryable;
    this.code = code;
    // A refusal that will not be retried was, by definition, not accepted. A
    // retryable failure is assumed AMBIGUOUS unless the site proves otherwise.
    this.delivery = delivery ?? (retryable ? 'unknown' : 'not_sent');
  }
}

/** Errors raised before any byte of the request could have been accepted. */
const NEVER_CONNECTED = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN',
  // nodemailer: connection, DNS, TLS and auth all fail before DATA is sent.
  'ECONNECTION', 'EDNS', 'ETLS', 'EAUTH',
]);

/** Classify a transport-level error: was the request certainly never delivered? */
export function connectionDelivery(e: unknown): Delivery {
  const err = e as { code?: string; cause?: { code?: string } };
  const code = err?.cause?.code ?? err?.code;
  return code && NEVER_CONNECTED.has(code) ? 'not_sent' : 'unknown';
}

/** HTTP statuses that mean the vendor received the request and did NOT act on it. */
export const HTTP_NOT_PROCESSED = new Set([402, 429, 502, 503]);
