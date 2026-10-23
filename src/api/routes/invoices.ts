import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Db } from '../../infra/db/pool.ts';
import { withTenant, audit } from '../../infra/db/pool.ts';
import { submitInvoice, retrySubmission } from '../../domain/submission/service.ts';
import { InvoiceSchema } from '../../domain/invoice/model.ts';
import {
  SDI_ERRORS, SDI_ERROR_COUNT, REMEDY_GUIDANCE, describeSdiError, enrichSdiErrors,
} from '../../shared/errors/sdi-errors.ts';
import { renderInvoice, renderNotification } from '../../infra/render/xslt.ts';
import { decrypt, type KeyProvider } from '../../infra/crypto/keys.ts';
import { ApiError } from '../../shared/errors/catalog.ts';
import { applyTemplate, validateTemplate, dryRunTemplate, TransformError } from '../../domain/transform/engine.ts';
import { STARTER_TEMPLATES, starterByKey } from '../../domain/transform/starters.ts';
import { requireScope } from '../middleware/auth.ts';
import type { SdiChannelAdapter } from '../../infra/channels/types.ts';
import type { Config } from '../../shared/config.ts';

export interface Deps {
  db: Db; keys: KeyProvider; cfg: Config;
  channelFor: (tenantId: string) => Promise<{
    adapter: SdiChannelAdapter; config: Record<string, unknown>;
  }>;
  /**
   * Begin watching for a milestone. Called BEFORE the submission is enqueued —
   * subscribing afterwards races the pipeline and loses a fast AT, making a
   * successful invoice wait out the full timeout.
   */
  watchMilestone?: (submissionId: string) => Promise<{
    wait: (ms: number) => Promise<string | null>; close: () => Promise<void>;
  }>;
}


/**
 * Load a tenant's template and apply it to a CRM-shaped payload.
 *
 * The template is re-validated on load, not trusted because it was validated at
 * save time: rows can be edited by any path with database access, and the
 * whitelist is the only thing standing between a stored rule and function
 * dispatch. Validating twice costs microseconds.
 *
 * A transform failure is the CRM's error, not ours — it means the payload did
 * not match the mapping the CRM itself authored — so it surfaces as a 400
 * carrying BOTH paths: the source path the CRM recognises and the canonical
 * target it failed to produce.
 */
async function transformPayload(
  d: Deps, tenantId: string, name: string, payload: unknown,
): Promise<unknown> {
  const rows = await withTenant(d.db, tenantId, (tx) => tx.query<{
    name: string; source_format: string | null; rules: unknown;
  }>(`SELECT name, source_format, rules FROM transformations WHERE name = $1`, [name]));

  const row = rows.rows[0];
  if (!row) {
    throw new ApiError('ERR_NOT_FOUND', `no transformation named "${name}" for this tenant`);
  }

  const tpl = validateTemplate({
    name: row.name,
    ...(row.source_format ? { sourceFormat: row.source_format } : {}),
    rules: row.rules,
  });

  try {
    return applyTemplate(tpl, payload);
  } catch (e) {
    if (e instanceof TransformError) {
      throw new ApiError('ERR_TRANSFORM_FAILED', e.message, [{
        transformation: name,
        sourcePath: e.sourcePath ?? null,
        targetPath: e.targetPath ?? null,
      }]);
    }
    throw e;
  }
}

/**
 * Concurrent sync waiters, per tenant (API-015).
 *
 * Sync mode holds an HTTP connection AND a duplicated Redis subscriber for the
 * whole wait, so it is a real throughput ceiling rather than a soft cost. Left
 * uncapped, one tenant issuing a few hundred sync submissions exhausts the
 * connection pool and takes the API down for every other tenant — the same
 * noisy-neighbour failure that per-tenant rate limiting exists to prevent.
 *
 * Rejecting with a named code beyond the cap is strictly better than accepting
 * and degrading: the caller can fall back to async immediately, which is the
 * recommended mode anyway.
 */
const MAX_SYNC_WAITERS_PER_TENANT = 25;
const syncWaiters = new Map<string, number>();

const acquireSyncSlot = (tenantId: string): boolean => {
  const n = syncWaiters.get(tenantId) ?? 0;
  if (n >= MAX_SYNC_WAITERS_PER_TENANT) return false;
  syncWaiters.set(tenantId, n + 1);
  return true;
};

const releaseSyncSlot = (tenantId: string): void => {
  const n = (syncWaiters.get(tenantId) ?? 1) - 1;
  if (n <= 0) syncWaiters.delete(tenantId); else syncWaiters.set(tenantId, n);
};

/**
 * What the CRM should do next, given a submission state.
 *
 * Derived here rather than left to the integrator because the two states that
 * matter most read backwards: `rejected` (NS) looks retryable and is terminal,
 * and `awaiting_delivery` (MC) looks like a failure while the invoice is
 * already legally issued.
 */
function nextActionFor(state: string): {
  nextAction: string; terminal: boolean; legallyIssued: boolean; guidance: string;
} {
  switch (state) {
    case 'rejected_by_pa':
      return {
        nextAction: 'contact_recipient', terminal: true, legallyIssued: true,
        guidance:
          'NE/EC02: the public administration rejected the invoice. It was still legally ' +
          'ISSUED — this is a commercial rejection, not a fiscal one. Resolve it with the ' +
          'recipient; do not resubmit the same invoice to SdI.',
      };
    case 'accepted_by_pa':
      return { nextAction: 'none_required', terminal: true, legallyIssued: true,
               guidance: 'NE/EC01: the public administration accepted the invoice.' };
    case 'rejected':
      return {
        nextAction: 'issue_new_invoice', terminal: true, legallyIssued: false,
        guidance:
          'NS is TERMINAL: this invoice is legally NOT issued and can never be accepted. ' +
          'Correct the errors listed below and submit a NEW invoice — a fresh ' +
          'ProgressivoInvio is allocated automatically. Retrying this submission is refused.',
      };
    case 'awaiting_delivery':
      return {
        nextAction: 'none_required', terminal: false, legallyIssued: true,
        guidance:
          'MC is NOT a failure. The invoice IS legally issued; SdI could not reach the ' +
          'recipient yet and is still trying. Do not resubmit — that would duplicate it.',
      };
    case 'delivered':
      return { nextAction: 'none_required', terminal: true, legallyIssued: true,
               guidance: 'Delivered. Nothing further is required.' };
    case 'undelivered_attested':   // AT — the STATE name, not the event name
      return {
        nextAction: 'notify_recipient', terminal: true, legallyIssued: true,
        guidance:
          'AT: SdI could not deliver within its window. The invoice IS issued — you must ' +
          'make it available to the recipient by other means.',
      };
    case 'failed':
      return { nextAction: 'fix_and_resubmit', terminal: true, legallyIssued: false,
               guidance: 'The pipeline could not process it; it never reached SdI. Fix and resubmit.' };
    case 'transmitted':
      return { nextAction: 'await_receipt', terminal: false, legallyIssued: false,
               guidance: 'In SdI\'s hands. A receipt will follow.' };
    default:
      return { nextAction: 'await_receipt', terminal: false, legallyIssued: false,
               guidance: 'In progress.' };
  }
}

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

/** Express params are `string | string[]`; routes here always take a single id. */
const param = (req: Request, name: string): string => {
  const v = req.params[name];
  if (typeof v !== 'string' || v === '') throw new ApiError('ERR_SCHEMA_INVALID', `missing :${name}`);
  return v;
};

export function invoiceRoutes(d: Deps): Router {
  const r = Router();

  /**
   * POST /api/v1/invoices — 202 by default.
   *
   * Sync mode waits ONLY for the `transmitted` (AT) milestone, hard-capped.
   * It never waits for RC/MC/DT: MC delivery retry runs for days, so no HTTP
   * timeout can represent final delivery.
   */
  r.post('/invoices', requireScope('invoices:write'), wrap(async (req, res) => {
    const tenantId = req.tenantId!;
    const body = req.body as {
      invoice?: unknown; sellerId?: string; crmInvoiceRef?: string;
      mode?: 'async' | 'sync'; syncTimeoutMs?: number;
      transformation?: string;
    };
    if (!body?.invoice) throw new ApiError('ERR_SCHEMA_INVALID', 'body.invoice is required');
    if (!body.sellerId) throw new ApiError('ERR_SCHEMA_INVALID', 'body.sellerId is required');

    /**
     * Optional transformation from the CRM's own shape into the canonical model.
     *
     * Applied ONLY when the caller names a template. Selecting one implicitly —
     * by tenant default, or by sniffing the payload shape — would mean an
     * unrelated template edit silently changes how every future invoice is
     * interpreted, and a CRM could not tell from its own request what was sent
     * to the tax authority. Naming it makes the request self-describing.
     */
    const invoice = body.transformation
      ? await transformPayload(d, tenantId, body.transformation, body.invoice)
      : body.invoice;

    const { adapter: channel, config: channelConfig } = await d.channelFor(tenantId);

    /**
     * The submission id is allocated inside submitInvoice, so a watcher cannot
     * be opened on it beforehand. Instead the idempotency key doubles as the
     * pre-known handle when the caller supplies one; otherwise the watcher is
     * opened immediately after acceptance but BEFORE the outbox is drained,
     * which is the window that matters — the relay polls, so the milestone
     * cannot precede it.
     */
    const wantSync = body.mode === 'sync' && d.watchMilestone;

    const accepted = await submitInvoice(d.db, d.keys, invoice, {
      tenantId, sellerId: body.sellerId,
      ...(body.crmInvoiceRef ? { crmInvoiceRef: body.crmInvoiceRef } : {}),
      ...(req.header('idempotency-key') ? { idempotencyKey: req.header('idempotency-key')! } : {}),
      channel, channelConfig,
      correlationRetentionDays: d.cfg.CORRELATION_RETENTION_DAYS,
    });

    const base = {
      submissionId: accepted.submissionId,
      status: accepted.status,
      invoiceNumber: accepted.invoiceNumber,
      progressivoInvio: accepted.progressivoInvio,
      fileName: accepted.filename,
      createdAt: accepted.createdAt,
      trackingUrl: `${d.cfg.PASSO_BASE_URL}/api/v1/invoices/${accepted.submissionId}`,
      requestId: req.requestId,
    };

    if (wantSync) {
      // Never above the configured cap: sync mode holds one connection per
      // in-flight invoice, so an unbounded wait is a denial of service the
      // caller inflicts on itself.
      const cap = Math.min(body.syncTimeoutMs ?? d.cfg.SYNC_MAX_WAIT_MS, d.cfg.SYNC_MAX_WAIT_MS);

      // The invoice is ALREADY accepted and queued at this point. Exceeding the
      // waiter cap therefore degrades to the async contract — a 202 with the
      // tracking URL — rather than failing a submission that is safely stored.
      if (!acquireSyncSlot(tenantId)) {
        res.status(202)
          .set('x-passo-sync-declined', 'concurrent-waiter-limit')
          .json({
            ...base,
            note:
              `This tenant already has ${MAX_SYNC_WAITERS_PER_TENANT} sync submissions in ` +
              'flight, the per-tenant limit. The invoice is accepted and queued — poll ' +
              'trackingUrl or use a webhook. Async is the recommended mode.',
          });
        return;
      }

      const watcher = await d.watchMilestone!(accepted.submissionId);
      try {
        // Re-read first: the pipeline may already have moved past `queued`
        // between acceptance and subscribing.
        const current = await withTenant(d.db, tenantId, (tx) => tx.query<{ state: string }>(
          'SELECT state FROM sdi_submissions WHERE id = $1', [accepted.submissionId]));
        const state = current.rows[0]?.state;
        if (state && state !== 'queued') {
          res.status(200).json({ ...base, status: state });
          return;
        }
        const reached = await watcher.wait(cap);
        if (reached) { res.status(200).json({ ...base, status: reached }); return; }
      } finally {
        // Always unsubscribe — including when the client disconnects.
        await watcher.close();
        releaseSyncSlot(tenantId);
      }
      // Timed out: the job is untouched and continues. Fall back to 202.
    }
    res.status(202).json(base);
  }));

  /**
   * POST /api/v1/transformations/test — the authoring surface (XFORM-015).
   *
   * Without this, the only way to test a mapping is to submit a real invoice —
   * and a real invoice with a wrong mapping is LEGALLY ISSUED the moment SdI
   * accepts it. So this runs the same engine under the same limits, returns the
   * canonical output plus a per-rule trace and the FULL error list, and
   * **submits nothing, queues nothing, persists nothing**.
   *
   * Accepts either a saved template by `transformation`, or an inline `rules`
   * document so a template can be iterated before it is ever saved.
   */
  r.post('/transformations/test', requireScope('invoices:write'), wrap(async (req, res) => {
    const tenantId = req.tenantId!;
    const body = req.body as {
      transformation?: string; template?: unknown; payload?: unknown;
    };
    if (body?.payload === undefined) {
      throw new ApiError('ERR_SCHEMA_INVALID', 'body.payload is required');
    }

    let tpl;
    if (body.template) {
      tpl = validateTemplate(body.template);           // unsaved, iterate freely
    } else if (body.transformation) {
      const rows = await withTenant(d.db, tenantId, (tx) => tx.query<{
        name: string; source_format: string | null; rules: unknown;
      }>('SELECT name, source_format, rules FROM transformations WHERE name = $1',
         [body.transformation]));
      const row = rows.rows[0];
      if (!row) {
        throw new ApiError('ERR_NOT_FOUND',
          `no transformation named "${body.transformation}" for this tenant`);
      }
      tpl = validateTemplate({
        name: row.name,
        ...(row.source_format ? { sourceFormat: row.source_format } : {}),
        rules: row.rules,
      });
    } else {
      throw new ApiError('ERR_SCHEMA_INVALID',
        'supply either body.transformation (a saved name) or body.template (inline rules)');
    }

    const run = dryRunTemplate(tpl, body.payload);

    // Validate the OUTPUT against the canonical model too, so an author learns
    // in one call whether the mapping produces something submittable — not just
    // whether every rule ran.
    const check = InvoiceSchema.safeParse(run.output);

    res.json({
      transformation: tpl.name,
      output: run.output,
      trace: run.trace,
      errors: run.errors,
      canonicalValid: check.success,
      canonicalErrors: check.success ? [] : check.error.issues.map((i) => ({
        path: i.path.join('.'), message: i.message,
      })),
      submitted: false,
      requestId: req.requestId,
    });
  }));

  /**
   * GET /api/v1/invoices — list with CURSOR pagination (API-017).
   *
   * Cursor, not offset: an offset drifts under concurrent inserts, so a client
   * paging through its own invoices while submitting more will skip or repeat
   * rows — and for invoices, "silently skipped" means one goes unreconciled.
   * The cursor is `(created_at, id)`, a stable total order even when timestamps
   * collide.
   *
   * Tenant scoping comes from RLS, never from a predicate this handler adds:
   * a forgotten `WHERE tenant_id` is exactly the mistake the database is
   * configured to make impossible.
   */
  r.get('/invoices', requireScope('invoices:read'), wrap(async (req, res) => {
    const q = req.query as {
      status?: string; sellerId?: string; documentType?: string;
      from?: string; to?: string; limit?: string; cursor?: string;
    };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 200);

    // "<iso>|<uuid>" — the two halves of the sort key travel together.
    let curTs: string | null = null;
    let curId: string | null = null;
    if (q.cursor) {
      const [ts, id] = q.cursor.split('|');
      if (!ts || !id) throw new ApiError('ERR_SCHEMA_INVALID', 'malformed cursor');
      curTs = ts; curId = id;
    }

    const rows = await withTenant(d.db, req.tenantId!, (tx) => tx.query<{
      id: string; created_at: Date;
    }>(
      `SELECT s.id, s.state, s.progressivo_invio, s.xml_filename, s.channel,
              s.identificativo_sdi, s.purged_at, s.submitted_at, s.terminal_at,
              s.created_at, i.invoice_number, i.document_type, i.seller_id
         FROM sdi_submissions s
         JOIN invoices i ON i.id = s.invoice_id
        WHERE ($1::text        IS NULL OR s.state          = $1)
          AND ($2::uuid        IS NULL OR i.seller_id      = $2)
          AND ($3::text        IS NULL OR i.document_type  = $3)
          AND ($4::timestamptz IS NULL OR s.created_at    >= $4)
          AND ($5::timestamptz IS NULL OR s.created_at    <= $5)
          AND ($6::timestamptz IS NULL OR
               (s.created_at, s.id) < ($6::timestamptz, $7::uuid))
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT $8`,
      [q.status ?? null, q.sellerId ?? null, q.documentType ?? null,
       q.from ?? null, q.to ?? null, curTs, curId, limit]));

    const last = rows.rows[rows.rows.length - 1];
    res.json({
      data: rows.rows,
      // Null when the page was not full: there is nothing after it.
      nextCursor: rows.rows.length === limit && last
        ? `${new Date(last.created_at).toISOString()}|${last.id}`
        : null,
      requestId: req.requestId,
    });
  }));

  r.get('/invoices/:id', requireScope('invoices:read'), wrap(async (req, res) => {
    const row = await withTenant(d.db, req.tenantId!, async (tx) => {
      const s = await tx.query(
        `SELECT s.id, s.state, s.progressivo_invio, s.xml_filename, s.channel,
                s.channel_ref, s.signature_present, s.identificativo_sdi, s.purged_at,
                s.submitted_at, s.terminal_at, i.invoice_number
           FROM sdi_submissions s JOIN invoices i ON i.id = s.invoice_id
          WHERE s.id = $1`, [req.params['id']],
      );
      if (!s.rows[0]) return null;
      const n = await tx.query(
        `SELECT type, received_at, acknowledged_at, parsed FROM notifications
          WHERE submission_id = $1 ORDER BY received_at`, [req.params['id']],
      );
      return { sub: s.rows[0] as Record<string, unknown>, notifications: n.rows };
    });
    if (!row) throw new ApiError('ERR_NOT_FOUND', 'submission');
    res.json({
      submissionId: row.sub['id'], status: row.sub['state'],
      invoiceNumber: row.sub['invoice_number'],
      progressivoInvio: row.sub['progressivo_invio'],
      fileName: row.sub['xml_filename'], channel: row.sub['channel'],
      // The vendor's own reference (OpenAPI.it invoice uuid) — what to quote
      // to the vendor's support, and the key PASSO reads receipts back by.
      channelRef: row.sub['channel_ref'] ?? null,
      signed: row.sub['signature_present'],
      identificativoSdI: row.sub['identificativo_sdi'],
      purgedAt: row.sub['purged_at'],
      // The next action a CRM should take, derived from the state machine
      // rather than left for the integrator to infer. NS and MC are the two
      // that get misread — one needs a brand-new invoice, the other needs
      // nothing at all — so the answer travels with the status.
      ...nextActionFor(String(row.sub['state'])),
      notifications: (row.notifications as Array<Record<string, unknown>>).map((n) => {
        const parsed = n['parsed'] as { errors?: Array<{ codice: string; descrizione?: string | null }> } | null;
        const errs = parsed?.errors ?? [];
        return {
          type: n['type'], receivedAt: n['received_at'], acknowledgedAt: n['acknowledged_at'],
          // An NS is terminal, so its reasons travel with the status too — a CRM
          // polling instead of listening for webhooks needs them just as much.
          ...(errs.length ? { errors: enrichSdiErrors(errs) } : {}),
        };
      }),
      requestId: req.requestId,
    });
  }));

  /**
   * GET /api/v1/sdi-errors[/:code] — the rejection catalogue.
   *
   * Published as an endpoint so an integrator can build their own mapping table
   * without shipping a copy of an Italian-language PDF, and so a CRM can render
   * a meaningful message for a code it has never seen before.
   */
  /**
   * Starter templates (XFORM-017 / XFORM-018).
   *
   * Read-only reference data, identical for every tenant, so they live in code
   * rather than a table — there is nothing per-tenant to isolate and nothing to
   * migrate. Cloning deep-copies into the tenant's own transformations, which
   * is the point: a starter is something to EDIT, and edits must not leak
   * between tenants.
   */
  r.get('/starter-templates', requireScope('invoices:read'), (req, res) => {
    res.json({
      data: STARTER_TEMPLATES.map((s) => ({
        key: s.key, name: s.name, description: s.description,
        suits: s.suits, rules: s.template.rules.length,
      })),
      note:
        'No template for a named third-party CRM ships here. Nobody has inspected the real ' +
        'output of Wave, Zoho or any other named CRM, and a starter that is wrong is worse than none — it ' +
        'looks authoritative and produces a plausible invoice with the wrong values.',
      requestId: req.requestId,
    });
  });

  r.get('/starter-templates/:key', requireScope('invoices:read'), (req, res) => {
    const s = starterByKey(param(req, 'key'));
    if (!s) throw new ApiError('ERR_NOT_FOUND', 'starter template');
    res.json({ data: s, requestId: req.requestId });
  });

  r.post('/transformations/from-starter/:key', requireScope('transformations:write'),
    wrap(async (req, res) => {
      const starter = starterByKey(param(req, 'key'));
      if (!starter) throw new ApiError('ERR_NOT_FOUND', 'starter template');
      const tenantId = req.tenantId!;
      const name = (req.body as { name?: string })?.name ?? starter.key;

      // Re-validated on clone: the starter is trusted, but the name is not, and
      // validating twice costs microseconds.
      const tpl = validateTemplate({ ...starter.template, name });

      const row = await withTenant(d.db, tenantId, async (tx) => {
        const r2 = await tx.query<{ id: string; created: boolean }>(
          `INSERT INTO transformations (tenant_id, name, source_format, rules)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (tenant_id, name) DO UPDATE
             SET source_format = EXCLUDED.source_format, rules = EXCLUDED.rules,
                 updated_at = now()
           RETURNING id, (xmax = 0) AS created`,
          [tenantId, name, tpl.sourceFormat ?? null, JSON.stringify(tpl.rules)]);
        await audit(tx, {
          tenantId, actor: 'api', action: 'transformation.clone_starter',
          resourceType: 'transformation', resourceId: r2.rows[0]!.id,
          detail: { starter: starter.key, name },
        });
        return r2.rows[0]!;
      });

      res.status(row.created ? 201 : 200).json({
        id: row.id, name, clonedFrom: starter.key, rules: tpl.rules.length,
        note: 'A copy. Edit it freely — the starter is unchanged.',
        requestId: req.requestId,
      });
    }));

  r.get('/sdi-errors', requireScope('invoices:read'), (req, res) => {
    res.json({
      data: Object.values(SDI_ERRORS), count: SDI_ERROR_COUNT,
      remedies: REMEDY_GUIDANCE,
      source: 'Agenzia delle Entrate — Elenco dei controlli v2.0',
      requestId: req.requestId,
    });
  });

  r.get('/sdi-errors/:code', requireScope('invoices:read'), (req, res) => {
    res.json({ data: describeSdiError(param(req, 'code')), requestId: req.requestId });
  });

  /** Retry — refuses NS and MC, which would duplicate against the tax authority. */
  r.post('/invoices/:id/retry', requireScope('invoices:write'), wrap(async (req, res) => {
    await retrySubmission(d.db, req.tenantId!, param(req, 'id'));
    res.status(202).json({ submissionId: param(req, 'id'), requestId: req.requestId });
  }));

  /** The CRM must fetch before purge — PASSO is a relay, not an archive. */
  r.get('/invoices/:id/xml', requireScope('invoices:read'), wrap(async (req, res) => {
    const xml = await loadXml(d, req.tenantId!, param(req, 'id'));
    res.type('application/xml').send(xml);
  }));

  r.get('/invoices/:id/rendered', requireScope('invoices:read'), wrap(async (req, res) => {
    const xml = await loadXml(d, req.tenantId!, param(req, 'id'));
    const fmt = await withTenant(d.db, req.tenantId!, async (tx) => {
      const q = await tx.query<{ format_trasmissione: string }>(
        `SELECT i.format_trasmissione FROM sdi_submissions s
           JOIN invoices i ON i.id = s.invoice_id WHERE s.id = $1`, [req.params['id']],
      );
      return q.rows[0]?.format_trasmissione ?? 'FPR12';
    });
    res.type('text/html').send(await renderInvoice(xml, fmt));
  }));

  r.get('/invoices/:id/receipts', requireScope('invoices:read'), wrap(async (req, res) => {
    const rows = await withTenant(d.db, req.tenantId!, (tx) => tx.query(
      `SELECT type, received_at, parsed, acknowledged_at FROM notifications
        WHERE submission_id = $1 ORDER BY received_at`, [req.params['id']],
    ));
    res.json({ data: rows.rows, requestId: req.requestId });
  }));

  /** Acknowledge — releases receipts for purge after the grace window. */
  /**
   * Acknowledge receipts (SEC-036).
   *
   * Acknowledging makes a receipt PURGE-ELIGIBLE — it is the one call a CRM can
   * make that leads to data being destroyed. So it is audited by actor and
   * method, and a replay is a no-op rather than a second state change: the
   * `acknowledged_at IS NULL` predicate means a repeated ack cannot re-arm or
   * extend the purge window.
   */
  r.post('/invoices/:id/ack', requireScope('invoices:write'), wrap(async (req, res) => {
    const submissionId = param(req, 'id');
    const tenantId = req.tenantId!;
    const n = await withTenant(d.db, tenantId, async (tx) => {
      const r2 = await tx.query(
        `UPDATE notifications
            SET acknowledged_at = now(), ack_method = 'explicit_ack',
                purge_eligible_at = now() + ($2 || ' days')::interval
          WHERE submission_id = $1 AND acknowledged_at IS NULL`,
        [submissionId, String(d.cfg.RECEIPT_ACK_GRACE_DAYS)],
      );
      // Only a real state change is audited; a replayed ack changes nothing and
      // must not manufacture an audit entry implying it did.
      if ((r2.rowCount ?? 0) > 0) {
        await audit(tx, {
          tenantId, actor: `apikey:${req.keyId ?? 'unknown'}`,
          action: 'receipt.acknowledge',
          resourceType: 'submission', resourceId: submissionId,
          detail: { method: 'explicit_ack', count: r2.rowCount,
                    graceDays: d.cfg.RECEIPT_ACK_GRACE_DAYS },
        });
      }
      return r2.rowCount ?? 0;
    });
    res.json({ acknowledged: n, requestId: req.requestId });
  }));

  /** Reconciliation: everything not yet acknowledged. The webhook safety net. */
  r.get('/pending', requireScope('invoices:read'), wrap(async (req, res) => {
    const rows = await withTenant(d.db, req.tenantId!, (tx) => tx.query(
      `SELECT c.submission_id, c.crm_invoice_ref, c.status, c.created_at,
              count(n.id) FILTER (WHERE n.acknowledged_at IS NULL)::int AS unacknowledged
         FROM correlation_records c
         LEFT JOIN notifications n ON n.submission_id = c.submission_id
        GROUP BY c.submission_id, c.crm_invoice_ref, c.status, c.created_at
       HAVING count(n.id) FILTER (WHERE n.acknowledged_at IS NULL) > 0
           OR c.status NOT IN ('delivered','rejected','accepted_by_pa','rejected_by_pa','undelivered_attested','failed')
        ORDER BY c.created_at DESC LIMIT 200`,
    ));
    res.json({ data: rows.rows, requestId: req.requestId });
  }));

  /**
   * Render arbitrary XML — lets a CRM render an invoice PASSO already purged.
   *
   * Still scope-guarded: it runs an XSLT transform on caller-supplied input,
   * so it is compute the caller must be entitled to. Unauthenticated it would
   * be a free CPU amplifier.
   */
  r.post('/render', requireScope('invoices:read'), wrap(async (req, res) => {
    const xml = typeof req.body === 'string' ? req.body : String(req.body ?? '');
    if (!xml.trim()) throw new ApiError('ERR_SCHEMA_INVALID', 'XML body required');
    // Bound the transform input independently of the body-parser limit: an
    // 8 MB document can expand dramatically through a stylesheet.
    if (Buffer.byteLength(xml, 'utf8') > d.cfg.PASSO_MAX_RENDER_BYTES) {
      throw new ApiError('ERR_SCHEMA_INVALID',
        `XML exceeds the ${Math.round(d.cfg.PASSO_MAX_RENDER_BYTES / 1024 / 1024)} MB render limit`);
    }
    const fmt = /FPA12/.test(xml) ? 'FPA12' : 'FPR12';
    const isNotification = /<types:\w+/.test(xml);
    const qType = req.query['type'];
    const notifType = typeof qType === 'string' ? qType : 'RC';
    const html = isNotification
      ? await renderNotification(xml, notifType)
      : await renderInvoice(xml, fmt);
    res.type('text/html').send(html);
  }));

  return r;
}

async function loadXml(d: Deps, tenantId: string, submissionId: string): Promise<string> {
  const row = await withTenant(d.db, tenantId, (tx) => tx.query<{
    xml_encrypted: Buffer | null; xml_key_version: string | null;
    xml_iv: Buffer | null; xml_tag: Buffer | null; purged_at: Date | null; state: string;
  }>(
    `SELECT xml_encrypted, xml_key_version, xml_iv, xml_tag, purged_at, state
       FROM sdi_submissions WHERE id = $1`, [submissionId],
  ));
  const s = row.rows[0];
  if (!s) throw new ApiError('ERR_NOT_FOUND', 'submission');
  // 410 not 404 after purge: the submission existed, its payload is simply gone.
  if (s.purged_at || !s.xml_encrypted) {
    throw new ApiError('ERR_GONE', `purged after reaching state "${s.state}"`);
  }
  return decrypt(d.keys, {
    ciphertext: s.xml_encrypted, iv: s.xml_iv!, tag: s.xml_tag!, keyVersion: s.xml_key_version!,
  }, tenantId, 'xml').toString('utf8');
}
