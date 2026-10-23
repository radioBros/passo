import type { SdiChannelAdapter, SubmitInput, SubmitResult, ChannelHealth } from './types.ts';
import { ChannelError, connectionDelivery, HTTP_NOT_PROCESSED } from './types.ts';

/**
 * Invoicetronic.
 *
 * VERIFIED 2026-09-02 against the published documentation and by probing the
 * live API (unauthenticated, to observe routing and error shape only):
 *
 *   POST /v1/send/file        multipart, field name `file`  → 401 without auth
 *   POST /v1/send/file?signature=Apply                       vendor signs
 *   GET  /v1/receive          inbound documents              → 401 without auth
 *   GET  /v1/update           notification state per send_id
 *   GET  /v1/status, /v1/user, /v1/log, /v1/webhook          all exist
 *   /v1/invoices, /v1/notifications                          404 — do NOT exist
 *
 * Authentication is HTTP **Basic**, API key as the username with an EMPTY
 * password. An earlier revision sent `Authorization: Bearer`, which this API
 * rejects — every submission would have failed with a 401 that looked like a
 * credential problem on the operator's side.
 *
 * There is no separate sandbox host. The KEY selects the environment:
 * `ik_test_…` is sandbox, `ik_live_…` is production. That is a trap worth
 * naming — a live key in a staging config transmits real invoices to SdI.
 */
export interface InvoicetronicConfig {
  apiKey: string;
  baseUrl?: string;
  requestSigning?: boolean;
}

/** Vendor delivery states from GET /v1/update. */
export const INVOICETRONIC_STATE = {
  sent: 2,
  delivered: 5,
  rejected: 7,
} as const;

export class InvoicetronicChannel implements SdiChannelAdapter {
  readonly name = 'invoicetronic';
  readonly capabilities = {
    serverSideSigning: true, pushNotifications: true, maxMessageBytes: 30 * 1024 * 1024,
  };

  /** `?signature=Apply` is sent only when the tenant enabled signing. */
  willSign(config: Record<string, unknown>): boolean {
    return (config as unknown as InvoicetronicConfig).requestSigning === true;
  }

  private readonly defaultBaseUrl = 'https://api.invoicetronic.com/v1';

  /**
   * Basic auth: the API key is the username and the password is EMPTY, so the
   * encoded pair ends in a colon. Omitting the colon produces a different
   * credential that the API rejects.
   */
  private authHeaders(c: InvoicetronicConfig): Record<string, string> {
    return { Authorization: `Basic ${Buffer.from(`${c.apiKey}:`).toString('base64')}` };
  }

  /** True when the configured key is a sandbox key. Worth surfacing loudly. */
  static isSandboxKey(apiKey: string): boolean {
    return apiKey.startsWith('ik_test_');
  }

  async submit(input: SubmitInput, config: Record<string, unknown>): Promise<SubmitResult> {
    const c = config as unknown as InvoicetronicConfig;
    if (!c.apiKey) throw new ChannelError('invoicetronic: apiKey missing', false, 'ERR_CHANNEL_AUTH');
    const base = c.baseUrl ?? this.defaultBaseUrl;

    /**
     * Multipart with the field literally named `file` — NOT a JSON body or a
     * raw XML post. The filename matters: SdI derives the transmission
     * identity from it, so it travels as the multipart filename.
     */
    const form = new FormData();
    form.append('file', new Blob([input.xml], { type: 'application/xml' }), input.filename);

    // Signing is a QUERY PARAMETER, not a header.
    const url = `${base}/send/file${c.requestSigning && !input.signed ? '?signature=Apply' : ''}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this.authHeaders(c),   // no content-type: FormData sets the boundary
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError' || /timeout|timed out/i.test((e as Error).message)) {
        throw new ChannelError(`invoicetronic timed out: ${(e as Error).message}`,
          true, 'ERR_CHANNEL_TIMEOUT');
      }
      throw new ChannelError(`invoicetronic unreachable: ${(e as Error).message}`,
        true, 'ERR_CHANNEL_UNAVAILABLE', connectionDelivery(e));
    }

    if (res.status === 401 || res.status === 403) {
      throw new ChannelError('invoicetronic rejected the credentials', false, 'ERR_CHANNEL_AUTH');
    }
    if (res.status === 429) {
      throw new ChannelError('invoicetronic rate limit', true, 'ERR_CHANNEL_UNAVAILABLE', 'not_sent');
    }
    if (res.status >= 500) {
      throw new ChannelError(`invoicetronic ${res.status}`, true, 'ERR_CHANNEL_UNAVAILABLE',
        HTTP_NOT_PROCESSED.has(res.status) ? 'not_sent' : 'unknown');
    }
    if (!res.ok) {
      // RFC 9110 problem+json: `title` and `detail` carry the useful part.
      const raw = await res.text();
      let detail = raw.slice(0, 400);
      try {
        const p = JSON.parse(raw) as { title?: string; detail?: string };
        detail = [p.title, p.detail].filter(Boolean).join(': ') || detail;
      } catch { /* not problem+json */ }
      throw new ChannelError(`invoicetronic ${res.status}: ${detail}`,
        false, 'ERR_CHANNEL_REJECTED');
    }

    /**
     * The send response is the document itself. `id` is the handle used later
     * with `GET /v1/update?send_id=…`; the IdentificativoSdI arrives with the
     * receipt, not here.
     */
    const body = await res.json() as {
      id?: number | string; file_name?: string; date_sent?: string;
    };
    return {
      ...(body.id !== undefined ? { channelRef: String(body.id) } : {}),
      acceptedAt: body.date_sent ? new Date(body.date_sent) : new Date(),
    };
  }

  /**
   * Reachability and credential validity (SDI-020).
   *
   * `GET /v1/status` — never a submission: a health check that submitted would
   * put a junk invoice in front of the tax authority every time an operator
   * refreshed a dashboard.
   *
   * A 401 is reported UNHEALTHY. The vendor is up, but it will refuse every
   * invoice, which is the operationally identical outcome.
   */
  async health(config: Record<string, unknown>): Promise<ChannelHealth> {
    const c = config as unknown as InvoicetronicConfig;
    const base = c.baseUrl ?? this.defaultBaseUrl;
    const started = Date.now();
    try {
      const res = await fetch(`${base}/status`, {
        method: 'GET', headers: this.authHeaders(c), signal: AbortSignal.timeout(5_000),
      });
      const latencyMs = Date.now() - started;
      if (res.status === 401 || res.status === 403) {
        return { ok: false, checked: 'GET /v1/status', latencyMs,
                 error: `vendor rejected the credentials (HTTP ${res.status})` };
      }
      return { ok: res.ok, checked: 'GET /v1/status', latencyMs,
               ...(res.ok ? {} : { error: `HTTP ${res.status}` }) };
    } catch (e) {
      return { ok: false, checked: 'GET /v1/status',
               latencyMs: Date.now() - started, error: (e as Error).message };
    }
  }
}
