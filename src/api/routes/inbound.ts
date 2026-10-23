import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import { randomBytes, createHash } from 'node:crypto';
import bcrypt from 'bcrypt';
import { withTx, audit, withTenant } from '../../infra/db/pool.ts';
import { parseNotification } from '../../domain/notification/parser.ts';
import { ingestNotification, ingestVendorReceipts } from '../../domain/notification/service.ts';
import { channelForTenant } from '../../infra/channels/registry.ts';
import { ApiError } from '../../shared/errors/catalog.ts';
import { logger } from '../../shared/logger.ts';
import type { Deps } from './invoices.ts';

/**
 * Inbound vendor webhooks (SDI-026 / NOTIF-007).
 *
 * Invoicetronic and OpenAPI.it PUSH notifications, so this endpoint is publicly
 * reachable AND it changes invoice state — the highest-value forgery target in
 * the system. A forged NS would tell a CRM its invoice was rejected when it was
 * not, and because NS is terminal the CRM would issue a replacement for a
 * perfectly valid document.
 *
 * Hardening, in the order a request meets it:
 *
 *   1. **Size cap before parsing.** An oversized body is refused without being
 *      buffered, so the endpoint cannot be used as a memory amplifier.
 *   2. **Per-tenant token**, in the path because vendor webhook UIs frequently
 *      cannot send custom headers. Hashed at rest; a leak is contained to one
 *      tenant and revocable without touching anyone else.
 *   3. **Parse after authentication**, never before. XML parsing is the most
 *      expensive and most attackable step; an unauthenticated caller must not
 *      be able to reach it.
 *   4. **Errors never echo the payload.** A reflected body turns this into an
 *      oracle for whatever the caller sent.
 */

const MAX_INBOUND_BYTES = 2 * 1024 * 1024;

const lookupHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 32);

export const newInboundToken = (): string => `pwh_${randomBytes(24).toString('base64url')}`;

export async function hashInboundToken(token: string): Promise<{ hash: string; lookup: string }> {
  return { hash: await bcrypt.hash(token, 12), lookup: lookupHash(token) };
}

interface Resolved { tenantId: string; channel: string }

/** Resolve a token to its tenant. Runs before any tenant context can exist. */
async function resolveInbound(
  d: Deps, token: string,
): Promise<Resolved> {
  const rows = await withTx(d.db, async (tx) => {
    await tx.query('SET LOCAL ROLE passo_auth');
    return tx.query<{ tenant_id: string; channel: string; inbound_token_hash: string }>(
      `SELECT tenant_id, channel, inbound_token_hash
         FROM inbound_webhook_auth WHERE inbound_token_lookup = $1`, [lookupHash(token)]);
  });
  for (const row of rows.rows) {
    if (await bcrypt.compare(token, row.inbound_token_hash)) {
      return { tenantId: row.tenant_id, channel: row.channel };
    }
  }
  // Indistinguishable from a malformed token: anything else confirms that a
  // valid token exists for some tenant.
  throw new ApiError('ERR_AUTH_INVALID');
}

/**
 * Find the vendor's invoice handle in a callback body.
 *
 * Only the HANDLE is taken from the body — never the receipt. A callback is a
 * hint that something changed; what changed is re-read from the vendor with
 * the tenant's own credentials, so a forged body can at most trigger a
 * harmless re-read. `invoice_uuid` is how OpenAPI.it notifications reference
 * their invoice; a bare `uuid` is accepted at the top level or under `data`,
 * where an invoice event carries it.
 */
export function vendorInvoiceRef(body: string): string | null {
  let json: unknown;
  try { json = JSON.parse(body); } catch { return null; }
  const isRef = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{16,64}$/i.test(v);
  const seen = new Set<unknown>();
  const find = (v: unknown, depth: number): string | null => {
    if (depth > 6 || v === null || typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    const o = v as Record<string, unknown>;
    if (isRef(o['invoice_uuid'])) return o['invoice_uuid'];
    for (const child of Object.values(o)) {
      const hit = find(child, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  const viaNotification = find(json, 0);
  if (viaNotification) return viaNotification;
  const o = json as Record<string, unknown> | null;
  const data = (o?.['data'] ?? null) as Record<string, unknown> | null;
  if (isRef(o?.['uuid'])) return o['uuid'];
  if (data && isRef(data['uuid'])) return data['uuid'];
  return null;
}

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

export function inboundRoutes(d: Deps): Router {
  const r = Router();

  r.post(
    '/inbound/:token',
    // Bounded before anything reads it. Text, not JSON: vendors post raw XML,
    // and a JSON parser on XML produces a useless error.
    express.text({ type: '*/*', limit: MAX_INBOUND_BYTES }),
    wrap(async (req, res) => {
      const token = req.params['token'];
      if (typeof token !== 'string' || token.length < 16) {
        throw new ApiError('ERR_AUTH_INVALID');
      }

      const { tenantId, channel } = await resolveInbound(d, token);

      const body = typeof req.body === 'string' ? req.body : '';
      if (!body) throw new ApiError('ERR_SCHEMA_INVALID', 'empty body');

      /**
       * API vendors that can be READ BACK (OpenAPI.it): the callback names the
       * invoice, and the receipts are fetched from the vendor — the body is
       * never ingested. Their callbacks are JSON, not SdI XML, so the XML path
       * below would reject every one of them.
       */
      const { adapter, config } = await channelForTenant(d.db, d.keys, tenantId);
      if (adapter.name === channel && adapter.fetchReceipts) {
        const ref = vendorInvoiceRef(body);
        if (!ref) throw new ApiError('ERR_SCHEMA_INVALID', 'no invoice reference in callback');
        const sub = await withTenant(d.db, tenantId, (tx) => tx.query<{ id: string }>(
          'SELECT id FROM sdi_submissions WHERE channel = $1 AND channel_ref = $2',
          [channel, ref]));
        const submissionId = sub.rows[0]?.id;
        if (!submissionId) {
          // 200, not 4xx: a vendor retries non-2xx forever. The poller still
          // covers the submission once its handle is recorded.
          logger.warn({ tenantId, channel }, 'vendor callback for an unknown invoice reference');
          res.json({ received: true, status: 'unknown_reference', requestId: req.requestId });
          return;
        }
        const receipts = await adapter.fetchReceipts(config, ref);
        const results = await ingestVendorReceipts(
          d.db, d.keys, logger, tenantId, submissionId, channel, receipts);
        res.json({ received: true, status: 'verified',
                   applied: results.filter((x) => x.status === 'applied').length,
                   requestId: req.requestId });
        return;
      }

      let parsed;
      try {
        // Parsing happens only now — after authentication. The parser is
        // XXE-hardened, but an unauthenticated caller should never reach it.
        parsed = parseNotification(body);
      } catch {
        // The payload is NEVER echoed: reflecting it makes this an oracle.
        await withTenant(d.db, tenantId, (tx) => audit(tx, {
          tenantId, actor: `inbound:${channel}`, action: 'notification.unparseable',
          resourceType: 'notification', detail: { bytes: body.length },
        }));
        throw new ApiError('ERR_SCHEMA_INVALID', 'notification could not be parsed');
      }

      // The tenant comes from the TOKEN, not from the body. Passing it makes a
      // mismatch a refusal rather than a cross-tenant write.
      const result = await ingestNotification(
        d.db, d.keys, logger, parsed, channel, tenantId);

      // 200 even for a duplicate or a quarantine: a vendor that receives a
      // non-2xx retries, and retrying an already-ingested notification adds
      // load without changing anything.
      res.json({
        received: true, status: result.status,
        ...(result.newState ? { state: result.newState } : {}),
        requestId: req.requestId,
      });
    }),
  );

  return r;
}
