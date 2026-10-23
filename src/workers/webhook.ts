import { createHash } from 'node:crypto';
import type { Db } from '../infra/db/pool.ts';
import { withTenant } from '../infra/db/pool.ts';
import type { Broker, JobMessage } from '../infra/queue/broker.ts';
import { EXCHANGES, QUEUES, backoffMs, RETRY } from '../infra/queue/topology.ts';
import { decryptString, type KeyProvider } from '../infra/crypto/keys.ts';
import { signWebhook, validateWebhookUrl, pinnedDispatcher } from '../domain/webhook/security.ts';
import { enrichSdiErrors } from '../shared/errors/sdi-errors.ts';
// undici's own fetch, so the dispatcher and the client come from one package —
// Node's bundled undici-types and the installed undici disagree structurally.
import { fetch as undiciFetch } from 'undici';
import type { Logger } from '../shared/logger.ts';
import { asOptionalString } from '../shared/util/coerce.ts';
import { alert } from '../domain/alert/service.ts';

/**
 * Webhook dispatcher.
 *
 * Delivery is at-least-once, so receivers must dedupe on eventId. Failure past
 * the ladder leaves the item visible in GET /pending rather than dropping it.
 */
/**
 * The HTTP call is injectable so tests can observe a delivery without stubbing
 * a global. The default pins the connection to the validated IP.
 */
export type WebhookSender = (
  url: URL, init: { headers: Record<string, string>; body: string; ip: string },
) => Promise<{ status: number }>;

const defaultSender: WebhookSender = (url, init) => undiciFetch(url, {
  dispatcher: pinnedDispatcher(init.ip),
  method: 'POST',
  headers: init.headers,
  body: init.body,
  signal: AbortSignal.timeout(10_000),
});

export function startWebhookWorker(
  db: Db, broker: Broker, keys: KeyProvider, log: Logger, allowHttp = false,
  send: WebhookSender = defaultSender,
): Promise<void> {
  return broker.consume(QUEUES.webhook, async (msg: JobMessage) => {
    const { tenantId } = msg;
    const p = msg.payload;
    const eventType = asOptionalString(p['eventType']) ?? 'invoice.status_changed';

    const hooks = await withTenant(db, tenantId, (tx) => tx.query<{
      id: string; url: string; events: string[];
      secret_encrypted: Buffer; secret_key_version: string;
      secret_iv: Buffer; secret_tag: Buffer;
      previous_secret_encrypted: Buffer | null; previous_secret_key_version: string | null;
      previous_secret_iv: Buffer | null; previous_secret_tag: Buffer | null;
    }>(
      `SELECT id, url, events, secret_encrypted, secret_key_version, secret_iv, secret_tag,
              -- Only while the overlap window is OPEN. An expired previous
              -- secret must stop signing, or a rotation never actually ends.
              CASE WHEN previous_secret_expires_at > now()
                   THEN previous_secret_encrypted END   AS previous_secret_encrypted,
              CASE WHEN previous_secret_expires_at > now()
                   THEN previous_secret_key_version END AS previous_secret_key_version,
              CASE WHEN previous_secret_expires_at > now()
                   THEN previous_secret_iv END          AS previous_secret_iv,
              CASE WHEN previous_secret_expires_at > now()
                   THEN previous_secret_tag END         AS previous_secret_tag
         FROM webhooks WHERE active = true`,
    ));

    for (const h of hooks.rows) {
      if (h.events.length && !h.events.includes(eventType)) continue;

      const secret = decryptString(keys, {
        ciphertext: h.secret_encrypted, iv: h.secret_iv,
        tag: h.secret_tag, keyVersion: h.secret_key_version,
      }, tenantId, 'webhook_secret');

      /**
       * During a rotation overlap, sign with BOTH secrets and send both values
       * in one header. A receiver that has already deployed the new secret and
       * one that has not both verify successfully, which is what makes rotating
       * a secret something an integrator will actually do.
       */
      const previous = h.previous_secret_encrypted && h.previous_secret_key_version
        && h.previous_secret_iv && h.previous_secret_tag
        ? decryptString(keys, {
            ciphertext: h.previous_secret_encrypted, iv: h.previous_secret_iv,
            tag: h.previous_secret_tag, keyVersion: h.previous_secret_key_version,
          }, tenantId, 'webhook_secret')
        : null;

      /**
       * STABLE across retries. Receivers are told to dedupe on eventId, and it
       * used to be minted per delivery attempt — so every retry looked like a
       * new event. Assigned when the event is enqueued; a message from before
       * that change gets an id derived from its own contents.
       */
      const eventId = asOptionalString(p['eventId'])
        ?? createHash('sha256').update(`${tenantId}:${JSON.stringify(p)}`).digest('hex').slice(0, 32);
      const body = JSON.stringify({
        eventId, eventType, apiVersion: 'v1',
        timestamp: new Date().toISOString(),
        tenantId,
        data: {
          submissionId: p['submissionId'],
          notificationType: p['notificationType'],
          // NS: the invoice is legally not issued. These two flags are the
          // most-missed part of the contract, so they are always explicit.
          ...(p['notificationType'] === 'NS'
            ? {
                retryable: false, requiresNewSubmission: true,
                // Enriched: a bare "00423" tells an integrator nothing, and NS
                // is terminal — they MUST act on it, which needs the reason.
                errors: enrichSdiErrors(
                  (p['errors'] ?? []) as Array<{ codice: string; descrizione?: string | null }>),
              }
            : {}),
          // MC looks like a failure and is not — the invoice IS issued.
          ...(p['notificationType'] === 'MC'
            ? { legallyIssued: true, retryable: false, action: 'none_required' }
            : {}),
        },
      });

      // Signed and sent as the SAME bytes; the timestamp is fixed once so both
      // signatures in an overlap cover an identical base string.
      const at = Date.now();
      try {
        // Re-validate at send time: a hostname that resolved public at
        // registration can resolve private now (DNS rebinding).
        const { url, ip } = await validateWebhookUrl(h.url, { allowHttp });
        // Connect to the address that PASSED validation, not to whatever DNS
        // answers now — otherwise the check and the connection can disagree.
        const res = await send(url, {
          headers: {
            'content-type': 'application/json',
            // One header, both signatures during an overlap: "t=…,v1=<new>,v1=<old>".
            // The timestamp is shared so it stays inside both signed base strings.
            'x-passo-signature': previous
              ? `${signWebhook(body, secret, at)},${signWebhook(body, previous, at).split(',')[1]}`
              : signWebhook(body, secret, at),
            'x-passo-event': eventType,
            'x-passo-attempt': String(msg.attempt),
            'x-passo-event-id': eventId,
          },
          body,
          ip,
        });
        await withTenant(db, tenantId, (tx) => tx.query(
          `INSERT INTO webhook_deliveries
             (tenant_id, webhook_id, submission_id, event_id, event_type, attempt, http_status, delivered_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7 BETWEEN 200 AND 299 THEN now() END)`,
          [tenantId, h.id, p['submissionId'] ?? null, eventId, eventType, msg.attempt, res.status],
        ));
        if (res.status >= 200 && res.status <= 299) {
          log.info({ eventId, eventType }, 'webhook delivered'); continue;
        }
        throw new Error(`status ${res.status}`);
      } catch (e) {
        const attempt = msg.attempt + 1;
        await withTenant(db, tenantId, (tx) => tx.query(
          `INSERT INTO webhook_deliveries
             (tenant_id, webhook_id, submission_id, event_id, event_type, attempt, error, next_retry_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' milliseconds')::interval)`,
          [tenantId, h.id, p['submissionId'] ?? null, eventId, eventType, attempt,
           (e as Error).message, String(backoffMs(QUEUES.webhook, attempt))],
        ));
        if (attempt < RETRY[QUEUES.webhook].maxAttempts) {
          broker.publish(EXCHANGES.retry, `${tenantId}.${QUEUES.webhook}`,
            { ...msg, attempt }, { delayMs: backoffMs(QUEUES.webhook, attempt) });
        } else {
          // Exhausted: NOT lost. GET /pending surfaces it for reconciliation.
          log.error({ eventId, eventType, attempts: attempt }, 'webhook exhausted — see GET /pending');
          await alert({ tenantId, kind: 'webhook.delivery_failed', channel: null,
            detail: { webhookId: h.id, eventType, eventId, error: (e as Error).message.slice(0, 200) } });
        }
      }
    }
  });
}
