import type {
  SdiChannelAdapter, SubmitInput, SubmitResult, ChannelHealth, VendorReceipts,
} from './types.ts';
import { ChannelError, connectionDelivery } from './types.ts';
import {
  parseNotification, unwrapVendorNotifications, type ParsedNotification,
} from '../../domain/notification/parser.ts';

/**
 * OpenAPI.it SDI.
 *
 * VERIFIED 2026-10-01 against the vendor's machine-readable spec
 * (console.openapi.com/oas/en/sdi.openapi.json) AND a live sandbox round trip:
 * PASSO-generated B2B and B2G invoices accepted, a B2G invoice signed by the
 * vendor, receipts simulated and fetched back.
 *
 *   production  https://sdi.openapi.it
 *   sandbox     https://test.sdi.openapi.it       ← a DIFFERENT HOST, not a flag
 *
 *   POST /business_registry_configurations     register a seller (required first)
 *   POST /invoices                             submit as-is (raw XML)
 *   POST /invoices_signature                   vendor signs
 *   POST /invoices_legal_storage               submit + archive
 *   POST /invoices_signature_legal_storage     sign + archive
 *   GET  /invoices/{uuid}                      status, sdi_file_id, sdi_file_name
 *   GET  /invoices_notifications/{uuid}        receipts (Accept: application/xml)
 *   POST /api_configurations                   callback registration
 *
 * Facts the documentation does not state, observed in the sandbox:
 *
 * - **A seller must be registered first.** Without a business registry for
 *   its fiscal ID every call fails with error 661 — returned as HTTP 401, so
 *   it reads as a credential failure unless the envelope is checked first.
 * - **Signing is a property of the seller's registry**, not of the request.
 *   With `apply_signature: true` only `/invoices_signature` is accepted, with
 *   `false` only `/invoices` (error 387 otherwise). `requestSigning` must
 *   therefore match the registry, or every submission is refused.
 * - **The vendor names the file.** SdI sees `IT10442360961…_00C9u.xml` — the
 *   vendor's transmitter and sequence — not PASSO's filename. The document's
 *   own `DatiTrasmissione` is kept as PASSO wrote it.
 * - **Sandbox receipts are canned**: every simulated receipt carries
 *   IdentificativoSdI "111". Correlation is by the vendor uuid, never by the
 *   receipt body; the real IdentificativoSdI is `sdi_file_id`.
 *
 * Every response is an envelope `{ success, message, error, data }`, and
 * `success: false` can arrive with a 2xx. `error` is a NUMBER, sometimes
 * fractional (`125.22` = wrong token).
 */
export interface OpenApiConfig {
  token: string;
  baseUrl?: string;
  /** Must match the seller's registry `apply_signature` on OpenAPI.it. */
  requestSigning?: boolean;
  /** Ask the vendor to archive as well. Their conservazione, not PASSO's. */
  legalStorage?: boolean;
}

/** The envelope every OpenAPI.it response carries. */
interface OpenApiEnvelope<T> {
  success: boolean;
  message?: string;
  error?: number | string | null;
  data?: T | null;
}

export const OPENAPI_HOSTS = {
  production: 'https://sdi.openapi.it',
  sandbox: 'https://test.sdi.openapi.it',
} as const;

/** The callback events worth subscribing to for a TRANSMITTER. */
export const OPENAPI_CALLBACK_EVENTS = [
  'customer-invoice',        // our own sends
  'customer-notification',   // the receipts: rejections and acceptances
] as const;

/** Vendor error codes with a specific meaning, observed or documented. */
const VENDOR_ERR = {
  wrongToken: 125,           // "Wrong Token" (125.22)
  endpointMismatch: 387,     // signing endpoint disagrees with the registry
  fiscalIdNotRegistered: 420,
  noBusinessRegistry: 661,
  insufficientCredit: 611,   // "Billing error message: Insufficient Credit in Wallet"
  notEnoughCredit: 304,      // "Not enought credit in wallet" (sic) — submit, observed 2026-10-02
} as const;

const errorCode = (body: OpenApiEnvelope<unknown> | null): number | null => {
  const n = Number(body?.error);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

/**
 * Map a failed response to a ChannelError.
 *
 * The ENVELOPE is read before the HTTP status: the missing-registry error
 * arrives as a 401, and branching on the status first told an operator their
 * credentials were wrong when the seller was simply not set up.
 */
function failure(res: Response, body: OpenApiEnvelope<unknown> | null, what: string): ChannelError {
  const code = errorCode(body);
  const said = `${body?.message ?? `HTTP ${res.status}`}${code != null ? ` (error ${String(body?.error)})` : ''}`;

  if (code === VENDOR_ERR.noBusinessRegistry || code === VENDOR_ERR.fiscalIdNotRegistered) {
    return new ChannelError(
      `openapi: the seller is not set up on OpenAPI.it — create a business registry ` +
      `configuration for its fiscal ID (POST /business_registry_configurations). Vendor: ${said}`,
      false, 'ERR_CHANNEL_SETUP');
  }
  if (code === VENDOR_ERR.endpointMismatch) {
    return new ChannelError(
      'openapi: "requestSigning" does not match the seller\'s OpenAPI.it configuration ' +
      `(apply_signature). Make them agree. Vendor: ${said}`,
      false, 'ERR_CHANNEL_SETUP');
  }
  if (code === VENDOR_ERR.wrongToken || res.status === 403) {
    return new ChannelError(`openapi rejected the credentials: ${said}`, false, 'ERR_CHANNEL_AUTH');
  }
  /**
   * Out of credit: HTTP 402 with vendor error 611, "Insufficient Credit in
   * Wallet: 0.001 > 0" — observed live on 2026-10-01/02. The vendor answered,
   * so nothing was accepted: RETRIED, and failing it would lose every invoice
   * queued while the wallet was empty. Its own code so an alert can say what
   * to do about it.
   */
  if (res.status === 402 || code === VENDOR_ERR.insufficientCredit || code === VENDOR_ERR.notEnoughCredit) {
    return new ChannelError(
      `openapi: the OpenAPI.it account is out of credit — nothing was sent; it is retried ` +
      `once the wallet is topped up. Vendor: ${said}`,
      true, 'ERR_CHANNEL_CREDIT', 'not_sent');
  }
  if (res.status === 429) {
    return new ChannelError('openapi rate limit', true, 'ERR_CHANNEL_UNAVAILABLE', 'not_sent');
  }
  if (res.status >= 500) {
    // 502/503: the vendor's gateway answered without processing. 500/504 may
    // have processed it — ambiguous, never retried automatically.
    return new ChannelError(`openapi ${res.status}`, true, 'ERR_CHANNEL_UNAVAILABLE',
      res.status === 502 || res.status === 503 ? 'not_sent' : 'unknown');
  }
  if (res.status === 401) {
    return new ChannelError(`openapi rejected the credentials: ${said}`, false, 'ERR_CHANNEL_AUTH');
  }
  return new ChannelError(`openapi refused the ${what}: ${said}`, false, 'ERR_CHANNEL_REJECTED');
}

export class OpenApiChannel implements SdiChannelAdapter {
  readonly name = 'openapi';
  readonly capabilities = {
    serverSideSigning: true, pushNotifications: true, maxMessageBytes: 30 * 1024 * 1024,
  };

  private readonly defaultBaseUrl = OPENAPI_HOSTS.production;

  /** Signing happens only via the `/invoices_signature*` paths, i.e. when enabled. */
  willSign(config: Record<string, unknown>): boolean {
    return (config as unknown as OpenApiConfig).requestSigning === true;
  }

  private authHeaders(c: OpenApiConfig): Record<string, string> {
    return { Authorization: `Bearer ${c.token}` };
  }

  /**
   * Which of the four submission endpoints to use.
   *
   * Signing and archiving are orthogonal, and the vendor exposes the
   * combination as four distinct paths rather than as parameters.
   */
  private path(c: OpenApiConfig, alreadySigned: boolean): string {
    const sign = c.requestSigning && !alreadySigned;
    if (sign && c.legalStorage) return '/invoices_signature_legal_storage';
    if (sign) return '/invoices_signature';
    if (c.legalStorage) return '/invoices_legal_storage';
    return '/invoices';
  }

  private async call(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if ((e as Error).name === 'AbortError' || (e as Error).name === 'TimeoutError' ||
          /timeout|timed out/i.test((e as Error).message)) {
        // The request may have arrived and been accepted: ambiguous.
        throw new ChannelError(`openapi timed out: ${(e as Error).message}`, true,
          'ERR_CHANNEL_TIMEOUT', 'unknown');
      }
      throw new ChannelError(`openapi unreachable: ${(e as Error).message}`, true,
        'ERR_CHANNEL_UNAVAILABLE', connectionDelivery(e));
    }
  }

  async submit(input: SubmitInput, config: Record<string, unknown>): Promise<SubmitResult> {
    const c = config as unknown as OpenApiConfig;
    if (!c.token) throw new ChannelError('openapi: token missing', false, 'ERR_CHANNEL_AUTH');
    const base = c.baseUrl ?? this.defaultBaseUrl;

    const res = await this.call(`${base}${this.path(c, input.signed ?? false)}`, {
      method: 'POST',
      headers: { ...this.authHeaders(c), 'Content-Type': 'application/xml' },
      body: input.xml,
    }, 30_000);

    const body = await res.json().catch(() => null) as
      OpenApiEnvelope<{ uuid?: string }> | null;

    /**
     * The envelope decides, not the HTTP status.
     *
     * `success: false` can arrive with a 2xx, so branching on `res.ok` alone
     * would record a failed submission as accepted — an invoice the CRM
     * believes is at SdI and which never arrived.
     */
    if (!res.ok || !body || body.success === false) throw failure(res, body, 'document');

    // `uuid` is the vendor's handle — the key every later receipt is fetched by.
    if (!body.data?.uuid) {
      throw new ChannelError('openapi accepted the document but returned no uuid', false,
        'ERR_CHANNEL_REJECTED');
    }
    return { channelRef: body.data.uuid, acceptedAt: new Date() };
  }

  /**
   * Receipts for one submission, read back from the vendor (NOTIF / SDI-026).
   *
   * Used by the poller AND to verify a webhook: a callback body is never
   * trusted, the receipts are re-read here with the tenant's own credentials.
   * They are fetched as the GENUINE SdI XML and go through the same hardened
   * parser as a PEC receipt; an unparseable receipt is returned as poison for
   * quarantine, never dropped.
   *
   * What the sandbox showed (2026-10-01/02), and why this reads the XML
   * directly every time:
   *  - the XML listing works with an EMPTY wallet — it is not billed;
   *  - the JSON-LD listing (no Accept) is NOT a reliable index: it still showed
   *    one receipt minutes after the XML showed two. Gating on it (an earlier
   *    version did) would have left a receipt unfetched for as long as the
   *    listing lagged;
   *  - the XML listing also lags at times, and for a few minutes answered an
   *    XML request with JSON-LD. A body that is not the XML envelope is a
   *    RETRYABLE condition — treating it as poison would quarantine a healthy
   *    response on every poll;
   *  - `GET /invoices/{uuid}` IS billed (402 "Insufficient Credit in Wallet"
   *    with an empty wallet) — read only while SdI's id is still unknown, and
   *    its failure never blocks applying a receipt.
   */
  async fetchReceipts(
    config: Record<string, unknown>, channelRef: string, opts: { withIds?: boolean } = {},
  ): Promise<VendorReceipts> {
    const c = config as unknown as OpenApiConfig;
    const base = c.baseUrl ?? this.defaultBaseUrl;
    const ref = encodeURIComponent(channelRef);

    const xmlRes = await this.call(`${base}/invoices_notifications/${ref}`,
      { headers: { ...this.authHeaders(c), Accept: 'application/xml' } }, 15_000);
    const text = await xmlRes.text();
    if (!xmlRes.ok) {
      const env = (() => { try { return JSON.parse(text) as OpenApiEnvelope<unknown>; } catch { return null; } })();
      throw failure(xmlRes, env, 'receipts request');
    }
    if (!/^\s*(<\?xml[^>]*\?>\s*)?<response[\s/>]/.test(text)) {
      throw new ChannelError(
        `openapi returned receipts for ${channelRef} in an unexpected format ` +
        `(${text.trimStart().slice(0, 1) === '{' ? 'JSON instead of XML' : 'not the XML envelope'}); will retry`,
        true, 'ERR_CHANNEL_UNAVAILABLE');
    }

    const notifications: ParsedNotification[] = [];
    const poison: VendorReceipts['poison'] = [];
    let items: Array<{ key: string; xml: string }>;
    try {
      items = unwrapVendorNotifications(text);
    } catch (e) {
      return { notifications, poison: [
        { reason: `openapi receipts envelope unparseable: ${(e as Error).message}`, raw: text },
      ] };
    }
    if (items.length === 0) return { notifications, poison };
    for (const item of items) {
      try {
        notifications.push(parseNotification(item.xml));
      } catch (e) {
        poison.push({ reason: `openapi receipt ${item.key} unparseable: ${(e as Error).message}`,
                      raw: item.xml });
      }
    }

    // The real IdentificativoSdI lives on the (billed) invoice record. Best
    // effort: a receipt is applied whether or not this succeeds.
    let ids = {};
    if (opts.withIds !== false) {
      try {
        const invRes = await this.call(`${base}/invoices/${ref}`,
          { headers: { ...this.authHeaders(c), Accept: 'application/json' } }, 15_000);
        const inv = await invRes.json().catch(() => null) as
          OpenApiEnvelope<{ sdi_file_id?: string | null; sdi_file_name?: string | null }> | null;
        if (invRes.ok && inv?.success !== false) ids = this.ids(inv?.data);
      } catch { /* best effort — see above */ }
    }
    return { ...ids, notifications, poison };
  }

  private ids(d: { sdi_file_id?: string | null; sdi_file_name?: string | null } | null | undefined) {
    return {
      ...(d?.sdi_file_id ? { identificativoSdI: String(d.sdi_file_id) } : {}),
      ...(d?.sdi_file_name ? { sdiFileName: d.sdi_file_name } : {}),
    };
  }

  /**
   * Reachability, credentials and seller setup (SDI-020).
   *
   * Reads the business registries rather than submitting: a health check that
   * submitted would put a junk invoice in front of the tax authority every
   * time an operator refreshed a dashboard. (An earlier version read
   * `GET /invoices_notifications`, which requires a uuid — so it reported a
   * perfectly valid account as down.)
   */
  async health(config: Record<string, unknown>): Promise<ChannelHealth> {
    const c = config as unknown as OpenApiConfig;
    const base = c.baseUrl ?? this.defaultBaseUrl;
    const checked = 'GET /business_registry_configurations';
    const started = Date.now();
    try {
      const res = await fetch(`${base}/business_registry_configurations`, {
        method: 'GET', headers: this.authHeaders(c), signal: AbortSignal.timeout(5_000),
      });
      const latencyMs = Date.now() - started;
      const body = await res.json().catch(() => null) as
        OpenApiEnvelope<Array<{ fiscal_id?: string; active?: boolean }>> | null;
      if (!res.ok || !body || body.success === false) {
        return { ok: false, checked, latencyMs, error: failure(res, body, 'health check').message };
      }
      const active = (body.data ?? []).filter((r) => r.active !== false);
      if (active.length === 0) {
        return { ok: false, checked, latencyMs,
                 error: 'credentials work, but no active business registry exists — every ' +
                        'submission will fail until the seller is registered on OpenAPI.it' };
      }
      return { ok: true, checked, latencyMs };
    } catch (e) {
      return { ok: false, checked, latencyMs: Date.now() - started, error: (e as Error).message };
    }
  }
}
