import type { Db } from '../infra/db/pool.ts';
import { withTenant, audit } from '../infra/db/pool.ts';
import type { Broker, JobMessage } from '../infra/queue/broker.ts';
import { EXCHANGES, QUEUES, backoffMs, RETRY } from '../infra/queue/topology.ts';
import { decrypt, type KeyProvider } from '../infra/crypto/keys.ts';
import { publishMilestone } from '../infra/queue/milestone.ts';
import type { Redis } from 'ioredis';
import { STATE } from '../domain/submission/state.ts';
import { ChannelError, type SdiChannelAdapter } from '../infra/channels/types.ts';
import { assertChannelCanCarry } from '../infra/channels/guards.ts';
import { enqueue } from '../infra/queue/outbox.ts';
import { randomUUID } from 'node:crypto';
import { alert, resolved as alertsResolved } from '../domain/alert/service.ts';
import { alertForChannelCode, RESOLVED_BY_SUCCESSFUL_SEND } from '../domain/alert/kinds.ts';
import type { Logger } from '../shared/logger.ts';
import { asString } from '../shared/util/coerce.ts';

/**
 * SdI submission worker.
 *
 * A transient channel failure is retried through the delayed exchange; a 4xx is
 * a configuration or payload defect and dead-letters immediately. Retrying a
 * rejection would submit a duplicate to the tax authority.
 */
export function startSubmitWorker(
  db: Db, broker: Broker, keys: KeyProvider, log: Logger,
  channelFor: (tenantId: string) => Promise<{ adapter: SdiChannelAdapter; config: Record<string, unknown> }>,
  /** Optional: releases sync-mode HTTP callers. Absent means they time out. */
  redis: Redis | null = null,
): Promise<void> {
  return broker.consume(QUEUES.submit, async (msg: JobMessage) => {
    const { tenantId } = msg;
    // asString rejects a non-scalar: String({}) would yield "[object Object]"
    // and then silently fail to match any submission id.
    const submissionId = asString(msg.payload['submissionId'], 'payload.submissionId');

    /**
     * CLAIM the submission atomically (single UPDATE ... RETURNING).
     *
     * The previous read-then-act had no lock and accepted `transmitting` as a
     * re-entry state, so two concurrent deliveries of the same message both
     * read `queued` and both submitted — a DUPLICATE at the tax authority,
     * which is rejected as 00409 and leaves two documents to explain.
     *
     * A conditional UPDATE lets exactly one worker win: the loser sees zero
     * rows and returns. Only `queued` is claimable — a submission already
     * `transmitting` is either in flight elsewhere or was interrupted, and
     * re-submitting on the strength of that state is what created duplicates.
     * An interrupted one is recovered by the stall detector, which can tell a
     * stuck submission from a live one; this code path cannot.
     */
    const claim = await withTenant(db, tenantId, (tx) => tx.query<{
      state: string; xml_encrypted: Buffer | null; xml_key_version: string | null;
      xml_iv: Buffer | null; xml_tag: Buffer | null; xml_filename: string | null;
      signature_present: boolean; attempt_no: number;
    }>(
      `UPDATE sdi_submissions
          SET state = $2, attempt_no = attempt_no + 1
        WHERE id = $1 AND state = $3
        RETURNING state, xml_encrypted, xml_key_version, xml_iv, xml_tag,
                  xml_filename, signature_present, attempt_no`,
      [submissionId, STATE.transmitting, STATE.queued],
    ));

    const s = claim.rows[0];
    if (!s) {
      // Another worker holds it, or it has moved past `queued`. Not an error.
      log.info({ submissionId }, 'submission not claimable — already in flight or past queued');
      return;
    }
    if (!s.xml_encrypted) { log.warn({ submissionId }, 'submission purged'); return; }

    const xml = decrypt(keys, {
      ciphertext: s.xml_encrypted, iv: s.xml_iv!, tag: s.xml_tag!, keyVersion: s.xml_key_version!,
    }, tenantId, 'xml').toString('utf8');

    // Inside the try below would be too late for the adapter name, so resolve
    // here but CATCH here: a missing or undecryptable channel configuration
    // used to escape straight to the DLQ and strand the invoice in
    // `transmitting` — claimed, never sent, never failed.
    let resolved: { adapter: SdiChannelAdapter; config: Record<string, unknown> };
    try {
      resolved = await channelFor(tenantId);
    } catch (e) {
      await onFailure(e, null);
      return;
    }
    const { adapter, config } = resolved;

    try {
      // Stage 2 of the channel guards: the tenant's channel configuration may
      // have changed since acceptance (e.g. signing switched off). Refusing is
      // permanent, never retried — an unsigned B2G invoice is a guaranteed NS.
      assertChannelCanCarry({ xml, signed: s.signature_present }, adapter, config);
      const r = await adapter.submit({
        tenantId, submissionId, xml,
        filename: s.xml_filename ?? 'invoice.xml', signed: s.signature_present,
      }, config);

      await withTenant(db, tenantId, async (tx) => {
        await tx.query(
          `UPDATE sdi_submissions
              SET state=$2, submitted_at=now(),
                  identificativo_sdi=COALESCE($3, identificativo_sdi),
                  pec_message_id=COALESCE($4, pec_message_id),
                  -- The vendor's handle: every later receipt is fetched by it.
                  channel_ref=COALESCE($5, channel_ref)
            WHERE id=$1`,
          [submissionId, STATE.transmitted, r.identificativoSdI ?? null, r.pecMessageId ?? null,
           r.channelRef ?? null],
        );
        await tx.query(
          `UPDATE correlation_records
              SET status=$2, transmitted_at=now(),
                  identificativo_sdi=COALESCE($3, identificativo_sdi),
                  pec_message_id=COALESCE($4, pec_message_id)
            WHERE submission_id=$1`,
          [submissionId, STATE.transmitted, r.identificativoSdI ?? null, r.pecMessageId ?? null],
        );
        await audit(tx, {
          tenantId, actor: `channel:${adapter.name}`, action: 'submission.transmitted',
          resourceType: 'submission', resourceId: submissionId,
        });
      });
      log.info({ submissionId, channel: adapter.name }, 'transmitted to SdI');
      // A successful send proves the channel's credit, setup and credentials are fine.
      await alertsResolved({ tenantId, channel: adapter.name, kinds: RESOLVED_BY_SUCCESSFUL_SEND });
      // Release any sync caller holding an HTTP connection for this invoice.
      await publishMilestone(redis, submissionId, STATE.transmitted, log);
    } catch (e) {
      await onFailure(e, adapter);
    }

    /**
     * What a failed transmission means for the invoice.
     *
     *  - `not_sent` and retryable: put it BACK to `queued`, then schedule the
     *    retry. Leaving it `transmitting` (as an earlier version did) made the
     *    retry find nothing claimable — every retryable failure, a vendor
     *    outage or an empty wallet, stranded the invoice forever, silently.
     *  - `unknown` (timeout, connection dropped mid-request): the vendor may
     *    have it. NOT resent automatically — that can duplicate the invoice
     *    at SdI. It stays `transmitting`, audited, for an operator to check
     *    the vendor and retry by hand (`POST /invoices/{id}/retry`).
     *  - otherwise (refused, or attempts exhausted): `failed`, and the CRM is
     *    told by a `submission.failed` webhook.
     */
    async function onFailure(e: unknown, a: SdiChannelAdapter | null): Promise<void> {
      const ce = e instanceof ChannelError ? e : null;
      // A non-channel error (configuration, decryption) happened BEFORE the
      // vendor was contacted, so nothing was sent.
      const delivery = ce ? ce.delivery : 'not_sent';
      const retryable = ce ? ce.retryable : true;
      const code = ce?.code ?? (e as { code?: string }).code ?? null;
      const attempts = s!.attempt_no;            // the claim already counted this one
      const message = (e as Error).message;
      const channel = a?.name ?? null;

      // Tell a person WHY sends are failing — a log line alone reaches nobody.
      const kind = ce ? alertForChannelCode(code) : 'channel.unreadable';
      if (kind) {
        await alert({ tenantId, kind, channel,
          detail: { latestSubmissionId: submissionId, code, error: message.slice(0, 300) } });
      }

      if (delivery === 'unknown') {
        await withTenant(db, tenantId, (tx) => audit(tx, {
          tenantId, actor: 'worker', action: 'submission.outcome_unknown',
          resourceType: 'submission', resourceId: submissionId,
          detail: { error: message, code, attempts, channel: a?.name ?? null },
        }));
        log.error({ submissionId, code, err: message },
          'transmission outcome UNKNOWN — left `transmitting`, NOT resent (duplicate risk); ' +
          'check the vendor, then POST /invoices/{id}/retry if it never arrived');
        await alert({ tenantId, kind: 'submission.outcome_unknown', channel,
          detail: { latestSubmissionId: submissionId, code, error: message.slice(0, 300) } });
        return;
      }

      if (retryable && attempts < RETRY[QUEUES.submit].maxAttempts) {
        await withTenant(db, tenantId, (tx) => tx.query(
          `UPDATE sdi_submissions SET state = $2 WHERE id = $1 AND state = $3`,
          [submissionId, STATE.queued, STATE.transmitting]));
        broker.publish(EXCHANGES.retry, `${tenantId}.${QUEUES.submit}`,
          { ...msg, attempt: attempts }, { delayMs: backoffMs(QUEUES.submit, attempts) });
        log.warn({ submissionId, attempts, code, err: message }, 'submission retry scheduled');
        return;
      }

      await withTenant(db, tenantId, async (tx) => {
        await tx.query('UPDATE sdi_submissions SET state=$2 WHERE id=$1', [submissionId, STATE.failed]);
        await audit(tx, {
          tenantId, actor: 'worker', action: 'submission.failed',
          resourceType: 'submission', resourceId: submissionId,
          detail: { error: message, code, attempts },
        });
        // The CRM's "why did my send fail": the event existed but was never emitted.
        await enqueue(tx, tenantId, EXCHANGES.invoices, `${tenantId}.${QUEUES.webhook}`, {
          eventId: randomUUID(), submissionId, eventType: 'submission.failed',
          error: { code, message: message.slice(0, 500), attempts },
        });
      });
      await alert({ tenantId, kind: 'submission.failed', channel,
        detail: { latestSubmissionId: submissionId, code, error: message.slice(0, 300), attempts } });
      // A terminal failure releases the sync caller too — waiting out the full
      // timeout on an invoice that already failed is the worst of both modes.
      await publishMilestone(redis, submissionId, STATE.failed, log);
    }
  });
}
