import { randomUUID } from 'node:crypto';
import type { Db } from '../../infra/db/pool.ts';
import { withTenant, withTx, routeNotification, audit } from '../../infra/db/pool.ts';
import type { ParsedNotification } from './parser.ts';
import { applyNotification, type State } from '../submission/state.ts';
import { encrypt, type KeyProvider } from '../../infra/crypto/keys.ts';
import { enqueue } from '../../infra/queue/outbox.ts';
import { EXCHANGES, QUEUES } from '../../infra/queue/topology.ts';
import type { Logger } from '../../shared/logger.ts';

/**
 * Notification ingress.
 *
 * A receipt can arrive days after the payload was purged — MC means SdI keeps
 * retrying delivery. The tenant is UNKNOWN at arrival, so routing goes through
 * the correlation record via the passo_router role, the one sanctioned RLS
 * bypass.
 *
 * An unmatched notification is QUARANTINED, never discarded: over PEC the
 * mailbox is the only copy of a legal receipt.
 */

export interface IngestResult {
  status: 'applied' | 'duplicate' | 'quarantined';
  tenantId?: string;
  submissionId?: string;
  newState?: State;
}

export async function ingestNotification(
  db: Db, keys: KeyProvider, log: Logger,
  n: ParsedNotification, channel: string,
  /**
   * The tenant the CALLER already authenticated, when it knows one.
   *
   * Both real ingress paths do: the inbound webhook resolved a per-tenant
   * token, and the PEC poller is iterating one tenant's mailbox. Without this,
   * the tenant was re-derived purely from `IdentificativoSdI` inside the
   * attacker-supplied XML — so a tenant holding any inbound token could post a
   * forged NotificaScarto carrying ANOTHER tenant's IdentificativoSdI and drive
   * their live invoice to `rejected`. NS is terminal, so that CRM would reissue
   * a document that was perfectly valid.
   *
   * Left undefined only where no tenant is knowable in advance.
   */
  expectedTenantId?: string,
  /**
   * The submission, when the caller already KNOWS it — an API vendor's
   * receipts are fetched by the vendor's handle for one submission of a known
   * tenant. Routing by the receipt body is then skipped: the body can carry a
   * placeholder IdentificativoSdI (the OpenAPI.it sandbox stamps "111" on
   * every receipt), and the bypass role is not needed when the tenant is known.
   */
  knownSubmissionId?: string,
): Promise<IngestResult> {
  // MT / EC / SE belong to the inbound-reception flow (v2). They are legitimate
  // messages, so they are quarantined for inspection, never treated as errors.
  if (!n.isTransmitterType) {
    await quarantine(db, n, channel, `receiver-flow notification (${n.type}) — inbound reception is v2`);
    return { status: 'quarantined' };
  }

  const hit = knownSubmissionId && expectedTenantId
    ? { tenantId: expectedTenantId, submissionId: knownSubmissionId }
    : await routeNotification(db, {
      ...(n.identificativoSdI ? { identificativoSdI: n.identificativoSdI } : {}),
      ...(n.pecMessageId ? { pecMessageId: n.pecMessageId } : {}),
    });
  /**
   * The routed tenant MUST match the one the caller authenticated.
   *
   * `routeNotification` runs under `passo_router`, which bypasses RLS by
   * design — it has to, because the whole point is finding a tenant that is not
   * yet known. That makes the routing key attacker-controlled input on any path
   * where the caller DID already authenticate a tenant, and a mismatch is
   * either a forgery or a vendor delivering to the wrong endpoint. Neither
   * should mutate the other tenant's invoice.
   */
  if (hit && expectedTenantId && hit.tenantId !== expectedTenantId) {
    await quarantine(db, n, channel, 'tenant mismatch — routed tenant is not the caller');
    log.error(
      { channel, expectedTenantId, routedTenantId: hit.tenantId,
        identificativoSdI: n.identificativoSdI, type: n.type },
      'REFUSED a notification whose IdentificativoSdI belongs to a DIFFERENT tenant. ' +
      'Quarantined, not applied. This is either a forged receipt or a vendor delivering ' +
      'to the wrong callback — investigate before re-associating.',
    );
    return { status: 'quarantined' as const };
  }

  if (!hit) {
    await quarantine(db, n, channel, 'no correlation record matched');
    log.warn({ type: n.type, identificativoSdI: n.identificativoSdI }, 'notification quarantined');
    return { status: 'quarantined' };
  }

  const cur = await withTenant(db, hit.tenantId, (tx) => tx.query<{ state: State }>(
    'SELECT state FROM sdi_submissions WHERE id = $1', [hit.submissionId],
  ));
  const state = cur.rows[0]?.state;

  /**
   * The correlation routed, but the submission row is gone — purged, or deleted
   * out from under us. The receipt is still a LEGAL DOCUMENT and over PEC the
   * mailbox is the only copy, so it must be quarantined rather than dropped.
   *
   * This previously returned `quarantined` WITHOUT quarantining anything: the
   * status told the caller the receipt was safe while the only copy was
   * discarded, and the PEC poller then marked the message read.
   */
  if (!state) {
    await quarantine(db, n, channel, 'submission_row_missing');
    log.warn(
      { submissionId: hit.submissionId, identificativoSdI: n.identificativoSdI, type: n.type },
      'receipt routed to a submission that no longer exists — QUARANTINED, not discarded',
    );
    return { status: 'quarantined' as const };
  }

  return withTenant(db, hit.tenantId, async (tx) => {

    const enc = encrypt(keys, n.raw, hit.tenantId, 'notification');
    // Redelivery is expected (vendor retries, IMAP re-reads). The unique
    // constraint makes a duplicate a no-op rather than a second state change.
    const ins = await tx.query(
      `INSERT INTO notifications
        (tenant_id, submission_id, type, identificativo_sdi, sdi_message_id,
         raw_encrypted, raw_key_version, raw_iv, raw_tag, parsed, channel)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING RETURNING id`,
      [hit.tenantId, hit.submissionId, n.type, n.identificativoSdI, n.messageId,
       enc.ciphertext, enc.keyVersion, enc.iv, enc.tag,
       JSON.stringify({ type: n.type, errors: n.errors, esito: n.esito, scarto: n.scarto }),
       channel],
    );
    if (ins.rowCount === 0) return { status: 'duplicate' as const, tenantId: hit.tenantId };

    const { next, terminal } = applyNotification(state, n.type, n.esito);
    await tx.query(
      `UPDATE sdi_submissions
          SET state = $2, identificativo_sdi = COALESCE(identificativo_sdi, $3),
              terminal_at = CASE WHEN $4 THEN now() ELSE terminal_at END
        WHERE id = $1`,
      [hit.submissionId, next, n.identificativoSdI, terminal],
    );
    await tx.query(
      `UPDATE correlation_records
          SET status = $2, terminal_at = CASE WHEN $3 THEN now() ELSE terminal_at END,
              identificativo_sdi = COALESCE(identificativo_sdi, $4)
        WHERE submission_id = $1`,
      [hit.submissionId, next, terminal, n.identificativoSdI],
    );

    // EXCHANGES.invoices, where every queue is bound. `passo.webhooks` has NO
    // bindings: events published there were confirmed and silently dropped, so
    // no CRM ever received a receipt webhook (found 2026-10-02).
    await enqueue(tx, hit.tenantId, EXCHANGES.invoices, `${hit.tenantId}.${QUEUES.webhook}`, {
      eventId: randomUUID(),
      submissionId: hit.submissionId,
      eventType: eventFor(n.type, n.esito),
      notificationType: n.type,
      errors: n.errors,
    });

    await audit(tx, {
      tenantId: hit.tenantId, actor: `channel:${channel}`, action: 'notification.ingest',
      resourceType: 'submission', resourceId: hit.submissionId,
      detail: { type: n.type, from: state, to: next },
    });

    return { status: 'applied' as const, tenantId: hit.tenantId, submissionId: hit.submissionId, newState: next };
  });
}

/** Webhook event names. NS and MC carry the flags integrators most often get wrong. */
export function eventFor(type: string, esito?: string | null): string {
  switch (type) {
    case 'RC': return 'invoice.delivered';
    case 'NS': return 'invoice.rejected';
    case 'MC': return 'invoice.exception';
    case 'DT': return 'invoice.delivered';
    case 'AT': return 'invoice.transmitted_undelivered';
    case 'NE': return esito === 'EC02' ? 'invoice.rejected_by_pa' : 'invoice.accepted_by_pa';
    default: return 'invoice.status_changed';
  }
}

/**
 * Quarantine a message that could not even be parsed into a notification —
 * unparseable MIME, an oversized message, a non-notification XML attachment.
 *
 * It may still be a legal receipt, so the raw bytes are kept for an operator;
 * the caller acknowledges the message only after this returns. The owning
 * mailbox is recorded in the reason because, unlike a routing failure, the
 * tenant here IS known — it is just not trusted to own the content.
 */
export async function quarantinePoison(
  db: Db, p: { reason: string; raw: string; filename?: string },
  channel: string, mailboxTenantId: string,
): Promise<void> {
  await withTx(db, (tx) => tx.query(
    `INSERT INTO quarantined_notifications (reason, filename, raw, channel)
     VALUES ($1,$2,$3,$4)`,
    [`${p.reason} [mailbox of tenant ${mailboxTenantId}]`, p.filename ?? null, p.raw, channel],
  ));
}

async function quarantine(
  db: Db, n: ParsedNotification, channel: string, reason: string,
): Promise<void> {
  // quarantined_notifications is NOT tenant-scoped: the tenant is precisely
  // what could not be determined.
  await withTx(db, (tx) => tx.query(
    `INSERT INTO quarantined_notifications (reason, type, identificativo_sdi, raw, channel)
     VALUES ($1,$2,$3,$4,$5)`,
    [reason, n.type, n.identificativoSdI, n.raw, channel],
  ));
}

/**
 * Apply one submission's receipts as read back from an API vendor.
 *
 * The vendor's own IdentificativoSdI is recorded FIRST, so the COALESCE in
 * ingestion keeps the real value rather than whatever a receipt body carries
 * (in the OpenAPI.it sandbox, a placeholder shared by every receipt). Each
 * receipt is then ingested against the known submission — idempotently, so
 * re-reading on every poll changes nothing — and anything unparseable is
 * quarantined with its raw bytes.
 */
export async function ingestVendorReceipts(
  db: Db, keys: KeyProvider, log: Logger,
  tenantId: string, submissionId: string, channel: string,
  r: { identificativoSdI?: string; notifications: ParsedNotification[];
       poison: Array<{ reason: string; raw: string }> },
): Promise<IngestResult[]> {
  if (r.identificativoSdI) {
    await withTenant(db, tenantId, async (tx) => {
      await tx.query(
        `UPDATE sdi_submissions SET identificativo_sdi = COALESCE(identificativo_sdi, $2)
          WHERE id = $1`, [submissionId, r.identificativoSdI]);
      await tx.query(
        `UPDATE correlation_records SET identificativo_sdi = COALESCE(identificativo_sdi, $2)
          WHERE submission_id = $1`, [submissionId, r.identificativoSdI]);
    });
  }
  for (const p of r.poison) {
    await quarantinePoison(db, p, channel, tenantId);
    log.error({ tenantId, submissionId, reason: p.reason },
      'vendor receipt could not be parsed — QUARANTINED for operator review');
  }
  const results: IngestResult[] = [];
  for (const n of r.notifications) {
    results.push(await ingestNotification(db, keys, log, n, channel, tenantId, submissionId));
  }
  return results;
}
