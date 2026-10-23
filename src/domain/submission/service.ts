import { createHash } from 'node:crypto';
import type { Db, Tx } from '../../infra/db/pool.ts';
import { withTenant, audit } from '../../infra/db/pool.ts';
import { enqueue } from '../../infra/queue/outbox.ts';
import { EXCHANGES, QUEUES } from '../../infra/queue/topology.ts';
import { InvoiceSchema, type Invoice } from '../invoice/model.ts';
import {
  assertChannelCanCarry, signingSatisfied, signingRequiredMessage,
} from '../../infra/channels/guards.ts';
import { generateInvoiceXml, invoiceFileName } from '../invoice/generator.ts';
import { assertValidInvoiceXml } from '../../infra/render/xsd.ts';
import { allocateProgressivo } from './progressivo.ts';
import { STATE, canRetry, RETRYABLE_STATES, type State } from './state.ts';
import { ApiError } from '../../shared/errors/catalog.ts';
import { encrypt, type KeyProvider } from '../../infra/crypto/keys.ts';
import type { SdiChannelAdapter } from '../../infra/channels/types.ts';

export interface SubmitOptions {
  tenantId: string;
  sellerId: string;
  crmInvoiceRef?: string;
  idempotencyKey?: string;
  channel: SdiChannelAdapter;
  /**
   * The tenant's decrypted channel configuration — decides, e.g., whether the
   * vendor signs. Omitted means `{}`, which fails SAFE: no vendor signs on an
   * empty config, so B2G is refused rather than transmitted unsigned.
   */
  channelConfig?: Record<string, unknown>;
  /**
   * How long the correlation record survives, in days. An operator sets this
   * via CORRELATION_RETENTION_DAYS; it defaults to the same 90 days the purge
   * worker assumes, so the two ends of the lifetime cannot silently disagree.
   */
  correlationRetentionDays?: number;
}

export interface SubmitAccepted {
  submissionId: string; status: State; invoiceNumber: string;
  progressivoInvio: string; filename: string; createdAt: string;
}

/**
 * Validate -> generate -> XSD-validate -> persist + enqueue, all in ONE
 * transaction. The 202 is returned only after COMMIT, so an accepted invoice is
 * durable before the caller is told so.
 */
/**
 * Map a zod failure to a specific business-rule code where one exists.
 *
 * Zod reports every refinement as a generic issue; the catalogue distinguishes
 * the ones with fiscal consequences so a CRM can handle them individually.
 */
function businessRuleCode(
  details: ReadonlyArray<{ path: string; message: string }>,
): 'ERR_NATURA_REQUIRED' | 'ERR_VALIDATION_PEC_REQUIRED' | 'ERR_SCHEMA_INVALID' {
  const all = details.map((d) => d.message).join(' | ');
  if (/Natura is required/i.test(all)) return 'ERR_NATURA_REQUIRED';
  if (/recipientPec is required/i.test(all)) return 'ERR_VALIDATION_PEC_REQUIRED';
  return 'ERR_SCHEMA_INVALID';
}

export async function submitInvoice(
  db: Db, keys: KeyProvider, raw: unknown, opts: SubmitOptions,
): Promise<SubmitAccepted> {
  const parsed = InvoiceSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map(
      (i) => ({ path: i.path.join('.'), message: i.message }));
    /**
     * Business rules get their OWN codes (API-009).
     *
     * These three are the mistakes that actually cost an NS, and an integrator
     * matching on `ERR_SCHEMA_INVALID` cannot tell them from a typo in a field
     * name. A specific code is something they can branch on and look up.
     */
    throw new ApiError(businessRuleCode(details), undefined, details);
  }
  const invoice: Invoice = parsed.data;

  // B2G signature gate — checked BEFORE a ProgressivoInvio is allocated. The
  // same rule runs again on the generated XML below and in the submit worker.
  if (!signingSatisfied(invoice.format === 'FPA12', false, opts.channel, opts.channelConfig ?? {})) {
    throw new ApiError('ERR_VALIDATION_SIGNATURE_REQUIRED', signingRequiredMessage(opts.channel));
  }

  return withTenant(db, opts.tenantId, async (tx) => {
    if (opts.idempotencyKey) {
      const hit = await replayIdempotent(tx, opts.tenantId, opts.idempotencyKey, raw);
      if (hit) return hit;
    }

    const tenant = await tx.query<{ transmitter_country: string; transmitter_code: string }>(
      'SELECT transmitter_country, transmitter_code FROM tenants WHERE id = $1', [opts.tenantId],
    );
    // tenants is not tenant-scoped, so this read works without RLS context.
    const t = tenant.rows[0];
    if (!t) throw new ApiError('ERR_NOT_FOUND', 'tenant');
    const transmitterId = `${t.transmitter_country}${t.transmitter_code}`;

    const progressivoInvio = await allocateProgressivo(tx, transmitterId);
    const meta = {
      transmitterCountry: t.transmitter_country,
      transmitterCode: t.transmitter_code,
      progressivoInvio,
    };

    const xml = generateInvoiceXml(invoice, meta);

    /**
     * Stage 1 of the channel guards (SDI-031 / SDI-032): reject BEFORE storing
     * or queueing. A document that cannot be carried will earn an NS, and NS is
     * terminal — so a 400 now is strictly better than a reissue later.
     */
    assertChannelCanCarry({ xml, signed: false }, opts.channel, opts.channelConfig ?? {});
    assertValidInvoiceXml(xml);                       // MANDATORY gate
    const filename = invoiceFileName(meta, false);

    const encPayload = encrypt(keys, JSON.stringify(invoice), opts.tenantId, 'payload');
    const inv = await tx.query<{ id: string }>(
      `INSERT INTO invoices
        (tenant_id, seller_id, crm_invoice_ref, invoice_number, document_type, issue_date,
         currency, format_trasmissione, recipient_code, recipient_pec,
         payload_encrypted, payload_key_version, payload_iv, payload_tag)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [opts.tenantId, opts.sellerId, opts.crmInvoiceRef ?? null, invoice.number,
       invoice.documentType, invoice.date, invoice.currency, invoice.format,
       invoice.recipientCode, invoice.recipientPec ?? null,
       encPayload.ciphertext, encPayload.keyVersion, encPayload.iv, encPayload.tag],
    );
    const invoiceId = inv.rows[0]!.id;

    const encXml = encrypt(keys, xml, opts.tenantId, 'xml');
    const sub = await tx.query<{ id: string }>(
      `INSERT INTO sdi_submissions
        (tenant_id, invoice_id, transmitter_id, progressivo_invio, channel, xml_filename,
         xml_sha256, xml_encrypted, xml_key_version, xml_iv, xml_tag, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [opts.tenantId, invoiceId, transmitterId, progressivoInvio, opts.channel.name, filename,
       createHash('sha256').update(xml).digest('hex'),
       encXml.ciphertext, encXml.keyVersion, encXml.iv, encXml.tag, STATE.queued],
    );
    const submissionId = sub.rows[0]!.id;

    // The forwarding address: IDs and status only, no fiscal or personal data.
    await tx.query(
      `INSERT INTO correlation_records
        (tenant_id, submission_id, crm_invoice_ref, progressivo_invio, transmitter_id, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval)`,
      [opts.tenantId, submissionId, opts.crmInvoiceRef ?? null,
       progressivoInvio, transmitterId, STATE.queued,
       String(opts.correlationRetentionDays ?? 90)],
    );

    // Same transaction as the rows above — this is what closes the dual-write hole.
    await enqueue(tx, opts.tenantId, EXCHANGES.invoices, `${opts.tenantId}.${QUEUES.submit}`,
      { submissionId, invoiceId });

    await audit(tx, {
      tenantId: opts.tenantId, actor: 'api', action: 'invoice.submit',
      resourceType: 'submission', resourceId: submissionId,
      detail: { invoiceNumber: invoice.number, progressivoInvio, channel: opts.channel.name },
    });

    const result: SubmitAccepted = {
      submissionId, status: STATE.queued, invoiceNumber: invoice.number,
      progressivoInvio, filename, createdAt: new Date().toISOString(),
    };
    if (opts.idempotencyKey) {
      await tx.query(
        `INSERT INTO idempotency_keys (tenant_id, key, request_hash, response, expires_at)
         VALUES ($1,$2,$3,$4, now() + interval '24 hours')`,
        [opts.tenantId, opts.idempotencyKey, hashOf(raw), JSON.stringify(result)],
      );
    }
    return result;
  });
}

const hashOf = (v: unknown): string =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');

async function replayIdempotent(
  tx: Tx, tenantId: string, key: string, raw: unknown,
): Promise<SubmitAccepted | null> {
  const r = await tx.query<{ request_hash: string; response: SubmitAccepted }>(
    'SELECT request_hash, response FROM idempotency_keys WHERE tenant_id=$1 AND key=$2 AND expires_at > now()',
    [tenantId, key],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.request_hash !== hashOf(raw)) throw new ApiError('ERR_CONFLICT_IDEMPOTENCY');
  return row.response;
}

/** Retry guard — refuses NS and MC, which would duplicate against the tax authority. */
export async function retrySubmission(
  db: Db, tenantId: string, submissionId: string,
): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    const r = await tx.query<{ state: State; invoice_id: string }>(
      'SELECT state, invoice_id FROM sdi_submissions WHERE id=$1', [submissionId],
    );
    const row = r.rows[0];
    if (!row) throw new ApiError('ERR_NOT_FOUND', 'submission');
    const guard = canRetry(row.state);
    if (!guard.ok) throw new ApiError(guard.reason as 'ERR_CONFLICT_NS_RETRY');
    // Back to `queued`, or the worker finds nothing claimable and the retry is
    // a silent no-op (it only claims `queued`). Conditional, so a concurrent
    // transition wins rather than being overwritten.
    const reset = await tx.query(
      `UPDATE sdi_submissions SET state = $2 WHERE id = $1 AND state = ANY($3::text[])`,
      [submissionId, STATE.queued, [...RETRYABLE_STATES]]);
    if (reset.rowCount === 0) throw new ApiError('ERR_CONFLICT_TERMINAL');
    await enqueue(tx, tenantId, EXCHANGES.invoices, `${tenantId}.${QUEUES.submit}`,
      { submissionId, invoiceId: row.invoice_id });
    await audit(tx, {
      tenantId, actor: 'api', action: 'submission.retry',
      resourceType: 'submission', resourceId: submissionId,
    });
  });
}
