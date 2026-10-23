import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { withTenant, audit } from '../../infra/db/pool.ts';
import { encrypt } from '../../infra/crypto/keys.ts';
import { validateWebhookUrl, SsrfError } from '../../domain/webhook/security.ts';
import {
  WEBHOOK_EVENTS, EVENT_CATALOGUE, assertValidEvents,
} from '../../domain/webhook/events.ts';
import { ApiError } from '../../shared/errors/catalog.ts';
import { requireScope } from '../middleware/auth.ts';
import { SCOPES, SCOPE_DESCRIPTIONS, DEFAULT_SCOPES } from '../../domain/apikey/scopes.ts';
import type { Deps } from './invoices.ts';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

const param = (req: Request, name: string): string => {
  const v = req.params[name];
  if (typeof v !== 'string' || v === '') throw new ApiError('ERR_SCHEMA_INVALID', `missing :${name}`);
  return v;
};

/** `whsec_` + 32 random bytes. Shown once, never retrievable afterwards. */
const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;

/** How long both signatures are emitted after a rotation. */
const OVERLAP_HOURS = 24;

/**
 * Tenant-facing webhook management (WH-015…WH-017).
 *
 * Previously this lived only behind the admin key, which meant a CRM could not
 * manage its own subscriptions without an operator — and the delivery history,
 * the single most useful debugging surface, was unreachable by the only people
 * who could act on it.
 */
export function webhookRoutes(d: Deps): Router {
  const r = Router();

  /** The scope catalogue, so an integrator can see what a key may be granted. */
  r.get('/scopes', requireScope('invoices:read'), (req, res) => {
    res.json({
      data: SCOPES.map((s) => ({ scope: s, description: SCOPE_DESCRIPTIONS[s] })),
      defaults: DEFAULT_SCOPES,
      requestId: req.requestId,
    });
  });

  /** The event catalogue. Public to any authenticated tenant. */
  r.get('/webhook-events', requireScope('invoices:read'), (req, res) => {
    res.json({
      data: Object.values(EVENT_CATALOGUE), count: WEBHOOK_EVENTS.length,
      requestId: req.requestId,
    });
  });

  r.post('/webhooks', requireScope('webhooks:write'), wrap(async (req, res) => {
    const tenantId = req.tenantId!;
    const b = req.body as { callbackUrl?: string; url?: string; events?: string[]; description?: string };
    const url = b.callbackUrl ?? b.url;
    if (!url) throw new ApiError('ERR_SCHEMA_INVALID', 'callbackUrl is required');

    /**
     * SSRF validation here is a fast-fail affordance, NOT the security
     * boundary: DNS can change between registration and delivery, so the
     * authoritative check runs again at every send (see workers/webhook.ts).
     */
    try {
      await validateWebhookUrl(url, { allowHttp: d.cfg.NODE_ENV !== 'production' });
    } catch (e) {
      if (e instanceof SsrfError) throw new ApiError('ERR_SCHEMA_INVALID', e.message);
      throw e;
    }

    let events: string[];
    try {
      events = assertValidEvents(b.events ?? ['invoice.delivered', 'invoice.rejected']);
    } catch (e) {
      throw new ApiError('ERR_SCHEMA_INVALID', (e as Error).message);
    }

    const secret = newSecret();
    const enc = encrypt(d.keys, secret, tenantId, 'webhook_secret');
    const row = await withTenant(d.db, tenantId, async (tx) => {
      const q = await tx.query<{ id: string }>(
        `INSERT INTO webhooks
           (tenant_id, url, events, description, secret_prefix,
            secret_encrypted, secret_key_version, secret_iv, secret_tag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [tenantId, url, events, b.description ?? null, secret.slice(0, 14),
         enc.ciphertext, enc.keyVersion, enc.iv, enc.tag],
      );
      await audit(tx, {
        tenantId, actor: 'api', action: 'webhook.create',
        resourceType: 'webhook', resourceId: q.rows[0]!.id,
      });
      return q.rows[0]!;
    });

    // The secret is shown ONCE. There is no endpoint that returns it again.
    res.status(201).json({
      id: row.id, callbackUrl: url, events, secret,
      note: 'Store this secret now — it is never shown again.',
      requestId: req.requestId,
    });
  }));

  r.get('/webhooks', requireScope('webhooks:read'), wrap(async (req, res) => {
    const rows = await withTenant(d.db, req.tenantId!, (tx) => tx.query(
      `SELECT id, url, events, description, active, disabled_reason,
              secret_prefix, consecutive_failures,
              previous_secret_expires_at, created_at, updated_at
         FROM webhooks ORDER BY created_at DESC`));
    res.json({ data: rows.rows, requestId: req.requestId });
  }));

  r.patch('/webhooks/:id', requireScope('webhooks:write'), wrap(async (req, res) => {
    const tenantId = req.tenantId!;
    const id = param(req, 'id');
    const b = req.body as { callbackUrl?: string; events?: string[]; active?: boolean; description?: string };

    if (b.callbackUrl) {
      try {
        await validateWebhookUrl(b.callbackUrl, { allowHttp: d.cfg.NODE_ENV !== 'production' });
      } catch (e) {
        if (e instanceof SsrfError) throw new ApiError('ERR_SCHEMA_INVALID', e.message);
        throw e;
      }
    }
    if (b.events) {
      try { assertValidEvents(b.events); }
      catch (e) { throw new ApiError('ERR_SCHEMA_INVALID', (e as Error).message); }
    }

    const updated = await withTenant(d.db, tenantId, async (tx) => {
      const q = await tx.query(
        `UPDATE webhooks
            SET url         = COALESCE($2, url),
                events      = COALESCE($3, events),
                description = COALESCE($4, description),
                active      = COALESCE($5, active),
                -- Re-enabling clears the failure state; leaving a stale count
                -- would re-disable it on the next single failure.
                consecutive_failures = CASE WHEN $5 IS TRUE THEN 0 ELSE consecutive_failures END,
                disabled_reason      = CASE WHEN $5 IS TRUE THEN NULL ELSE disabled_reason END,
                updated_at  = now()
          WHERE id = $1 RETURNING id`,
        [id, b.callbackUrl ?? null, b.events ?? null, b.description ?? null,
         b.active ?? null]);
      if (q.rows[0]) {
        await audit(tx, {
          tenantId, actor: 'api', action: 'webhook.update',
          resourceType: 'webhook', resourceId: id,
        });
      }
      return q.rowCount ?? 0;
    });
    if (updated === 0) throw new ApiError('ERR_NOT_FOUND', 'webhook');
    res.json({ id, requestId: req.requestId });
  }));

  /**
   * Rotate the signing secret with a bounded overlap (WH-007).
   *
   * Both the old and the new secret sign every delivery during the window, so a
   * receiver can accept either while it redeploys. Without the overlap, rotation
   * is a coordinated outage — which is why secrets never get rotated at all.
   */
  r.post('/webhooks/:id/rotate-secret', requireScope('webhooks:write'), wrap(async (req, res) => {
    const tenantId = req.tenantId!;
    const id = param(req, 'id');
    const hours = Math.min(Number((req.body as { overlapHours?: number })?.overlapHours ?? OVERLAP_HOURS), 168);
    const secret = newSecret();
    const enc = encrypt(d.keys, secret, tenantId, 'webhook_secret');

    const done = await withTenant(d.db, tenantId, async (tx) => {
      const q = await tx.query(
        `UPDATE webhooks SET
           previous_secret_encrypted   = secret_encrypted,
           previous_secret_key_version = secret_key_version,
           previous_secret_iv          = secret_iv,
           previous_secret_tag         = secret_tag,
           previous_secret_expires_at  = now() + ($6 || ' hours')::interval,
           secret_encrypted = $2, secret_key_version = $3,
           secret_iv = $4, secret_tag = $5,
           secret_prefix = $7, updated_at = now()
         WHERE id = $1 RETURNING id`,
        [id, enc.ciphertext, enc.keyVersion, enc.iv, enc.tag, String(hours),
         secret.slice(0, 14)]);
      if (q.rows[0]) {
        await audit(tx, {
          tenantId, actor: 'api', action: 'webhook.rotate_secret',
          resourceType: 'webhook', resourceId: id, detail: { overlapHours: hours },
        });
      }
      return q.rowCount ?? 0;
    });
    if (done === 0) throw new ApiError('ERR_NOT_FOUND', 'webhook');

    res.json({
      id, secret, overlapHours: hours,
      note: `Both signatures are sent for ${hours}h. Deploy this secret before the window closes.`,
      requestId: req.requestId,
    });
  }));

  r.delete('/webhooks/:id', requireScope('webhooks:write'), wrap(async (req, res) => {
    const tenantId = req.tenantId!;
    const id = param(req, 'id');
    const gone = await withTenant(d.db, tenantId, async (tx) => {
      const q = await tx.query('DELETE FROM webhooks WHERE id = $1 RETURNING id', [id]);
      if (q.rows[0]) {
        await audit(tx, {
          tenantId, actor: 'api', action: 'webhook.delete',
          resourceType: 'webhook', resourceId: id,
        });
      }
      return q.rowCount ?? 0;
    });
    if (gone === 0) throw new ApiError('ERR_NOT_FOUND', 'webhook');
    res.status(204).end();
  }));

  /**
   * Delivery history — the primary self-service debugging surface (WH-017).
   *
   * Its absence is what generates support tickets: without it, "the webhook
   * didn't arrive" is unanswerable by the only person who can see both ends.
   */
  r.get('/webhooks/:id/deliveries', requireScope('webhooks:read'), wrap(async (req, res) => {
    const id = param(req, 'id');
    const q = req.query as { eventType?: string; status?: string; limit?: string; before?: string };
    const limit = Math.min(Number(q.limit ?? 50) || 50, 200);

    const rows = await withTenant(d.db, req.tenantId!, (tx) => tx.query(
      `SELECT d.id, d.event_id, d.event_type, d.submission_id, d.attempt,
              d.http_status, d.error, d.delivered_at, d.next_retry_at, d.created_at
         FROM webhook_deliveries d
         JOIN webhooks w ON w.id = d.webhook_id
        WHERE d.webhook_id = $1
          AND ($2::text IS NULL OR d.event_type = $2)
          AND ($3::text IS NULL OR
               ($3 = 'failed'    AND d.delivered_at IS NULL) OR
               ($3 = 'delivered' AND d.delivered_at IS NOT NULL))
          AND ($4::timestamptz IS NULL OR d.created_at < $4)
        ORDER BY d.created_at DESC
        LIMIT $5`,
      [id, q.eventType ?? null, q.status ?? null, q.before ?? null, limit]));

    res.json({
      data: rows.rows,
      // Cursor pagination: the caller passes this back as `before`.
      nextCursor: rows.rows.length === limit
        ? (rows.rows[rows.rows.length - 1] as { created_at: Date }).created_at
        : null,
      requestId: req.requestId,
    });
  }));

  return r;
}
