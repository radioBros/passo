import { Router, type Request, type Response, type NextFunction } from 'express';
import { createApiKey, rotateApiKey, revokeApiKey } from '../../domain/apikey/service.ts';
import { assertValidScopes } from '../../domain/apikey/scopes.ts';
import {
  createMcpKey, listMcpKeys, rotateMcpKey, revokeMcpKey,
} from '../../domain/apikey/mcp-keys.ts';
import { withTx, withTenant, verifyAuditChain, withQuarantineRole } from '../../infra/db/pool.ts';
import { validateTemplate } from '../../domain/transform/engine.ts';
import { validateWebhookUrl, SsrfError } from '../../domain/webhook/security.ts';
import { sendTestAlert } from '../../domain/alert/service.ts';
import { encrypt } from '../../infra/crypto/keys.ts';
import { adapterByName, channelForTenant } from '../../infra/channels/registry.ts';
import { newInboundToken, hashInboundToken } from './inbound.ts';
import { audit } from '../../infra/db/pool.ts';
import { ApiError } from '../../shared/errors/catalog.ts';
import { asOptionalString } from '../../shared/util/coerce.ts';
import { randomBytes } from 'node:crypto';
import type { Deps } from './invoices.ts';
import { logger } from '../../shared/logger.ts';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

const need = (req: Request, name: string): string => {
  const v = req.params[name];
  if (typeof v !== 'string' || !v) throw new ApiError('ERR_SCHEMA_INVALID', `missing :${name}`);
  return v;
};

/** Admin surface. PASSO is API-only: there is no web UI, in MVP or later. */
export function adminRoutes(d: Deps): Router {
  const r = Router();

  r.post('/tenants', wrap(async (req, res) => {
    const b = req.body as { name?: string; slug?: string; transmitterCode?: string; transmitterCountry?: string };
    if (!b.name || !b.slug || !b.transmitterCode) {
      throw new ApiError('ERR_SCHEMA_INVALID', 'name, slug and transmitterCode are required');
    }
    const row = await withTx(d.db, (tx) => tx.query<{ id: string }>(
      `INSERT INTO tenants (name, slug, transmitter_country, transmitter_code)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [b.name, b.slug, b.transmitterCountry ?? 'IT', b.transmitterCode],
    ));
    res.status(201).json({ id: row.rows[0]!.id, requestId: req.requestId });
  }));

  r.post('/tenants/:tenantId/api-keys', wrap(async (req, res) => {
    const b = req.body as {
      name?: string; environment?: 'live' | 'test'; expiresInDays?: number; scopes?: string[];
    };
    // Scopes were previously accepted and DROPPED: a caller asking for a
    // read-only key silently received the full default set. Validate here so an
    // unknown scope fails loudly at creation rather than granting nothing later.
    if (b.scopes) {
      try { assertValidScopes(b.scopes); }
      catch (e) { throw new ApiError('ERR_SCHEMA_INVALID', (e as Error).message); }
    }
    const created = await createApiKey(d.db, need(req, 'tenantId'), b.name ?? 'default', {
      ...(b.environment ? { environment: b.environment } : {}),
      ...(b.expiresInDays ? { expiresInDays: b.expiresInDays } : {}),
      ...(b.scopes ? { scopes: b.scopes } : {}),
    });
    // The plaintext appears here ONCE and is never retrievable again.
    res.status(201).json({ ...created, warning: 'store this key now — it cannot be retrieved later' });
  }));

  r.post('/tenants/:tenantId/api-keys/:keyId/rotate', wrap(async (req, res) => {
    res.json(await rotateApiKey(d.db, need(req, 'tenantId'), need(req, 'keyId')));
  }));

  r.delete('/tenants/:tenantId/api-keys/:keyId', wrap(async (req, res) => {
    await revokeApiKey(d.db, need(req, 'tenantId'), need(req, 'keyId'));
    res.status(204).end();
  }));

  r.post('/tenants/:tenantId/webhooks', wrap(async (req, res) => {
    const tenantId = need(req, 'tenantId');
    const b = req.body as { url?: string; events?: string[] };
    if (!b.url) throw new ApiError('ERR_SCHEMA_INVALID', 'url is required');
    // SSRF: validated AND resolved before it is ever stored.
    await validateWebhookUrl(b.url, { allowHttp: process.env['NODE_ENV'] !== 'production' });
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const enc = encrypt(d.keys, secret, tenantId, 'webhook_secret');
    const row = await withTenant(d.db, tenantId, (tx) => tx.query<{ id: string }>(
      `INSERT INTO webhooks (tenant_id, url, events, secret_encrypted, secret_key_version, secret_iv, secret_tag)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [tenantId, b.url, b.events ?? ['invoice.delivered', 'invoice.rejected'],
       enc.ciphertext, enc.keyVersion, enc.iv, enc.tag],
    ));
    res.status(201).json({ id: row.rows[0]!.id, secret, url: b.url });
  }));

  /**
   * Save a transformation. Re-saving the same name UPDATES it.
   *
   * Names are the addressing scheme at submission time, so a second row with the
   * same name would make which mapping applies ambiguous. Upserting keeps
   * "save my template" idempotent — the natural thing for a CRM deploying a
   * config — rather than failing on the second deploy of the same file.
   */
  r.post('/tenants/:tenantId/transformations', wrap(async (req, res) => {
    const tenantId = need(req, 'tenantId');
    const tpl = validateTemplate(req.body);   // whitelist enforced at SAVE time
    const row = await withTenant(d.db, tenantId, async (tx) => {
      const r2 = await tx.query<{ id: string; created: boolean }>(
        `INSERT INTO transformations (tenant_id, name, source_format, rules)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, name) DO UPDATE
           SET source_format = EXCLUDED.source_format,
               rules         = EXCLUDED.rules,
               updated_at    = now()
         RETURNING id, (xmax = 0) AS created`,
        [tenantId, tpl.name, tpl.sourceFormat ?? null, JSON.stringify(tpl.rules)],
      );
      await audit(tx, {
        tenantId, actor: 'admin', action: 'transformation.save',
        resourceType: 'transformation', resourceId: r2.rows[0]!.id,
      });
      return r2.rows[0]!;
    });
    res.status(row.created ? 201 : 200).json({
      id: row.id, name: tpl.name, rules: tpl.rules.length, requestId: req.requestId,
    });
  }));

  r.get('/tenants/:tenantId/transformations', wrap(async (req, res) => {
    const rows = await withTenant(d.db, need(req, 'tenantId'), (tx) => tx.query(
      `SELECT id, name, source_format,
              jsonb_array_length(rules) AS rule_count, created_at, updated_at
         FROM transformations ORDER BY name`));
    res.json({ data: rows.rows, requestId: req.requestId });
  }));

  r.get('/tenants/:tenantId/transformations/:name', wrap(async (req, res) => {
    const rows = await withTenant(d.db, need(req, 'tenantId'), (tx) => tx.query(
      `SELECT id, name, source_format, rules, created_at, updated_at
         FROM transformations WHERE name = $1`, [need(req, 'name')]));
    if (!rows.rows[0]) throw new ApiError('ERR_NOT_FOUND', 'transformation');
    res.json({ data: rows.rows[0], requestId: req.requestId });
  }));

  r.delete('/tenants/:tenantId/transformations/:name', wrap(async (req, res) => {
    const tenantId = need(req, 'tenantId');
    const name = need(req, 'name');
    const gone = await withTenant(d.db, tenantId, async (tx) => {
      const r2 = await tx.query('DELETE FROM transformations WHERE name = $1 RETURNING id',
        [name]);
      if (r2.rows[0]) {
        await audit(tx, {
          tenantId, actor: 'admin', action: 'transformation.delete',
          resourceType: 'transformation', resourceId: (r2.rows[0] as { id: string }).id,
        });
      }
      return r2.rowCount ?? 0;
    });
    if (gone === 0) throw new ApiError('ERR_NOT_FOUND', 'transformation');
    res.status(204).end();
  }));

  /**
   * MCP keys (MCP-027). Separate from API keys and narrower by default: the
   * holder is a language model, so it reads and may retry a submission, but
   * cannot mint credentials or redirect a webhook.
   */
  r.post('/tenants/:tenantId/mcp-keys', wrap(async (req, res) => {
    const b = req.body as { name?: string; scopes?: string[]; expiresInDays?: number };
    if (b.scopes) {
      try { assertValidScopes(b.scopes); }
      catch (e) { throw new ApiError('ERR_SCHEMA_INVALID', (e as Error).message); }
    }
    const created = await createMcpKey(d.db, need(req, 'tenantId'), b.name ?? 'assistant', {
      ...(b.scopes ? { scopes: b.scopes } : {}),
      ...(b.expiresInDays ? { expiresInDays: b.expiresInDays } : {}),
    });
    res.status(201).json({
      ...created,
      warning: 'store this key now — it cannot be retrieved later',
      usage: 'Set PASSO_MCP_KEY on the mcp container.',
      requestId: req.requestId,
    });
  }));

  r.get('/tenants/:tenantId/mcp-keys', wrap(async (req, res) => {
    res.json({ data: await listMcpKeys(d.db, need(req, 'tenantId')), requestId: req.requestId });
  }));

  r.post('/tenants/:tenantId/mcp-keys/:keyId/rotate', wrap(async (req, res) => {
    res.json(await rotateMcpKey(d.db, need(req, 'tenantId'), need(req, 'keyId')));
  }));

  r.delete('/tenants/:tenantId/mcp-keys/:keyId', wrap(async (req, res) => {
    await revokeMcpKey(d.db, need(req, 'tenantId'), need(req, 'keyId'));
    res.status(204).end();
  }));

  /**
   * Per-tenant usage (KEY-019).
   *
   * RLS-scoped, so an operator asking about one tenant cannot accidentally
   * aggregate another's traffic into the answer.
   */
  /**
   * Per-tenant channel health (SDI-020).
   *
   * Deliberately NOT part of `/health/ready`: a vendor outage must not take
   * PASSO out of rotation, because Postgres is the durability boundary and
   * queued invoices submit when the vendor returns. This is the operator's
   * view, on demand.
   */
  r.get('/tenants/:tenantId/channels/health', wrap(async (req, res) => {
    const tenantId = need(req, 'tenantId');
    let result;
    try {
      const { adapter, config } = await channelForTenant(d.db, d.keys, tenantId);
      result = adapter.health
        ? { channel: adapter.name, ...(await adapter.health(config)) }
        : { channel: adapter.name, ok: true,
            checked: 'no health probe for this channel' };
    } catch (e) {
      result = {
        channel: null, ok: false, checked: 'channel resolution',
        error: e instanceof ApiError ? e.code : 'channel could not be resolved',
      };
    }
    // 200 regardless: this reports health, it does not HAVE health. A 503 here
    // would make a monitoring probe treat the API itself as down.
    res.json({ ...result, requestId: req.requestId });
  }));

  r.get('/tenants/:tenantId/usage', wrap(async (req, res) => {
    const q = req.query as { from?: string; to?: string; groupBy?: string };
    const groupBy = q.groupBy === 'route' ? 'route'
      : q.groupBy === 'key' ? 'key_id'
      : "date_trunc('day', at)::date::text";

    const rows = await withTenant(d.db, need(req, 'tenantId'), (tx) => tx.query(
      `SELECT ${groupBy} AS bucket,
              count(*)::int                                        AS requests,
              count(*) FILTER (WHERE status >= 400)::int           AS errors,
              count(*) FILTER (WHERE status = 429)::int            AS rate_limited,
              round(percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms))::int AS p50_ms,
              round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int AS p95_ms,
              round(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms))::int AS p99_ms
         FROM api_key_usage
        WHERE ($1::timestamptz IS NULL OR at >= $1)
          AND ($2::timestamptz IS NULL OR at <= $2)
        GROUP BY 1 ORDER BY 1 DESC LIMIT 200`,
      [q.from ?? null, q.to ?? null]));

    res.json({ data: rows.rows, groupBy: q.groupBy ?? 'day', requestId: req.requestId });
  }));

  r.get('/tenants/:tenantId/audit/verify', wrap(async (req, res) => {
    res.json(await verifyAuditChain(d.db, need(req, 'tenantId')));
  }));

  /** Sellers — the legal entities issuing invoices. One tenant, many sellers. */
  r.post('/tenants/:tenantId/sellers', wrap(async (req, res) => {
    const tenantId = need(req, 'tenantId');
    const b = req.body as {
      taxRegime?: string; denomination?: string; firstName?: string; lastName?: string;
      vatCountry?: string; vatCode?: string; taxCode?: string;
      address?: Record<string, unknown>;
    };
    if (!b.taxRegime) throw new ApiError('ERR_SCHEMA_INVALID', 'taxRegime (RegimeFiscale) is required');
    if (!b.denomination && !(b.firstName && b.lastName)) {
      throw new ApiError('ERR_SCHEMA_INVALID', 'provide denomination, or firstName and lastName');
    }
    if (!b.address) throw new ApiError('ERR_SCHEMA_INVALID', 'address is required');
    const row = await withTenant(d.db, tenantId, (tx) => tx.query<{ id: string }>(
      `INSERT INTO sellers (tenant_id, tax_regime, denomination, first_name, last_name,
                            vat_country, vat_code, tax_code, address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [tenantId, b.taxRegime, b.denomination ?? null, b.firstName ?? null, b.lastName ?? null,
       b.vatCountry ?? null, b.vatCode ?? null, b.taxCode ?? null, JSON.stringify(b.address)],
    ));
    res.status(201).json({ id: row.rows[0]!.id, requestId: req.requestId });
  }));

  r.get('/tenants/:tenantId/sellers', wrap(async (req, res) => {
    const rows = await withTenant(d.db, need(req, 'tenantId'), (tx) => tx.query(
      'SELECT id, denomination, first_name, last_name, vat_country, vat_code, tax_regime FROM sellers'));
    res.json({ data: rows.rows, requestId: req.requestId });
  }));

  /**
   * Channel configuration. Credentials are encrypted at rest and are NEVER
   * returned by any read endpoint — only their presence is reported.
   */
  r.put('/tenants/:tenantId/channels/:channel', wrap(async (req, res) => {
    const tenantId = need(req, 'tenantId');
    const channel = need(req, 'channel');
    if (!adapterByName(channel)) {
      throw new ApiError('ERR_CHANNEL_NOT_CONFIGURED', `unknown channel "${channel}"`);
    }
    const config = (req.body ?? {}) as Record<string, unknown>;

    /**
     * Refuse an obviously wrong environment pairing.
     *
     * Invoicetronic selects sandbox vs production by the KEY PREFIX on one
     * host, and OpenAPI.it by a different HOST. Both make it easy to point a
     * staging deployment at production — where a test invoice is transmitted
     * to the tax authority for real and cannot be recalled.
     */
    if (channel === 'invoicetronic') {
      const key = asOptionalString(config['apiKey']) ?? '';
      if (key && !/^ik_(test|live)_/.test(key)) {
        throw new ApiError('ERR_SCHEMA_INVALID',
          'an Invoicetronic key starts with ik_test_ (sandbox) or ik_live_ (production)');
      }
      if (key.startsWith('ik_live_') && d.cfg.NODE_ENV !== 'production') {
        throw new ApiError('ERR_SCHEMA_INVALID',
          'refusing a LIVE Invoicetronic key outside production — invoices sent with it ' +
          'reach the tax authority for real and cannot be recalled. Use an ik_test_ key.');
      }
    }
    if (channel === 'openapi') {
      const url = asOptionalString(config['baseUrl']) ?? '';
      if (url && !/^https:\/\/(test\.)?sdi\.openapi\.it/.test(url)) {
        throw new ApiError('ERR_SCHEMA_INVALID',
          'OpenAPI.it baseUrl must be https://sdi.openapi.it (production) or ' +
          'https://test.sdi.openapi.it (sandbox). Note .it — .com is the console.');
      }
      if (!url && d.cfg.NODE_ENV !== 'production') {
        throw new ApiError('ERR_SCHEMA_INVALID',
          'set baseUrl to https://test.sdi.openapi.it outside production — the default is ' +
          'the PRODUCTION host, and invoices sent there reach the tax authority for real.');
      }
    }
    const enc = encrypt(d.keys, JSON.stringify(config), tenantId, 'channel_config');
    await withTenant(d.db, tenantId, async (tx) => {
      await tx.query('UPDATE channel_credentials SET active = false WHERE tenant_id = $1', [tenantId]);
      await tx.query(
        `INSERT INTO channel_credentials
           (tenant_id, channel, config_encrypted, config_key_version, config_iv, config_tag, active)
         VALUES ($1,$2,$3,$4,$5,$6,true)
         ON CONFLICT (tenant_id, channel) DO UPDATE
           SET config_encrypted = EXCLUDED.config_encrypted,
               config_key_version = EXCLUDED.config_key_version,
               config_iv = EXCLUDED.config_iv,
               config_tag = EXCLUDED.config_tag,
               active = true, updated_at = now()`,
        [tenantId, channel, enc.ciphertext, enc.keyVersion, enc.iv, enc.tag],
      );
      await audit(tx, {
        tenantId, actor: 'admin', action: 'channel.configure',
        resourceType: 'channel', resourceId: channel,
      });
    });
    /**
     * Push-based channels get an inbound webhook token: the vendor sends
     * notifications to us, so it needs a URL that authenticates it. PEC and
     * mock are polled or local and need none — issuing one anyway would create
     * a credential nobody uses and nobody rotates.
     */
    let inbound: { url: string; token: string } | undefined;
    if (channel === 'invoicetronic' || channel === 'openapi') {
      const token = newInboundToken();
      const { hash, lookup } = await hashInboundToken(token);
      await withTenant(d.db, tenantId, (tx) => tx.query(
        `UPDATE channel_credentials
            SET inbound_token_hash = $3, inbound_token_lookup = $4
          WHERE tenant_id = $1 AND channel = $2`, [tenantId, channel, hash, lookup]));
      inbound = {
        url: `${d.cfg.PASSO_BASE_URL}/api/v1/inbound/${token}`,
        token,
      };
    }

    res.json({
      channel, configured: true,
      ...(inbound ? {
        inboundWebhookUrl: inbound.url,
        note: 'Configure this URL in the vendor console. It is shown once — the token is hashed at rest.',
      } : {}),
      requestId: req.requestId,
    });
  }));

  r.get('/tenants/:tenantId/channels', wrap(async (req, res) => {
    // Deliberately does NOT return credentials — only which channel is active.
    const rows = await withTenant(d.db, need(req, 'tenantId'), (tx) => tx.query(
      `SELECT channel, active, pec_sdi_address, pec_address_source, updated_at
         FROM channel_credentials`));
    res.json({ data: rows.rows, requestId: req.requestId });
  }));

  r.get('/tenants', wrap(async (req, res) => {
    const rows = await withTx(d.db, (tx) => tx.query(
      'SELECT id, name, slug, status, transmitter_country, transmitter_code, created_at FROM tenants'));
    res.json({ data: rows.rows, requestId: req.requestId });
  }));

  r.get('/tenants/:tenantId/api-keys', wrap(async (req, res) => {
    // key_hash is never exposed.
    const rows = await withTenant(d.db, need(req, 'tenantId'), (tx) => tx.query(
      `SELECT id, key_prefix, name, environment, scopes, status, expires_at, last_used_at, created_at
         FROM api_keys ORDER BY created_at DESC`));
    res.json({ data: rows.rows, requestId: req.requestId });
  }));

  /**
   * Quarantined receipts have no determinable tenant, so this listing is
   * global rather than tenant-scoped — reading it goes through the dedicated
   * `passo_quarantine` role and the metadata-only view, never the raw payload.
   */
  r.get('/quarantine', wrap(async (req, res) => {
    const rows = await withQuarantineRole(d.db, (tx) => tx.query(
      `SELECT id, type, identificativo_sdi, filename, reason, channel, created_at
         FROM quarantine_index WHERE resolved_at IS NULL
        ORDER BY created_at DESC LIMIT 200`,
    ));
    res.json({ data: rows.rows, requestId: req.requestId });
  }));

  /** The raw payload, fetched deliberately and one row at a time. */
  r.get('/quarantine/:id', wrap(async (req, res) => {
    const rows = await withQuarantineRole(d.db, (tx) => tx.query(
      `SELECT id, type, identificativo_sdi, filename, reason, channel, raw, created_at
         FROM quarantined_notifications WHERE id = $1`, [need(req, 'id')],
    ));
    if (rows.rows.length === 0) throw new ApiError('ERR_NOT_FOUND');
    res.json({ data: rows.rows[0], requestId: req.requestId });
  }));

  // ------------------------------------------------------------------ alerts
  /**
   * Where a tenant's alerts go — email and/or webhook, both optional. The
   * operator's own destinations (OPERATOR_ALERT_*) always receive them too.
   */
  const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
  const alertView = async (tenantId: string) => {
    const r = await withTenant(d.db, tenantId, (tx) => tx.query<{
      emails: string[]; webhook_url: string | null; has_secret: boolean; updated_at: Date;
    }>(`SELECT emails, webhook_url, webhook_secret_encrypted IS NOT NULL AS has_secret, updated_at
          FROM alert_settings WHERE tenant_id = $1`, [tenantId]));
    const row = r.rows[0];
    return {
      emails: row?.emails ?? [], webhookUrl: row?.webhook_url ?? null,
      webhookSigned: row?.has_secret ?? false,
      smtpConfigured: Boolean(d.cfg.ALERT_SMTP_HOST),
      operatorEmail: Boolean(d.cfg.OPERATOR_ALERT_EMAIL), operatorWebhook: Boolean(d.cfg.OPERATOR_ALERT_WEBHOOK_URL),
      ...(row ? { updatedAt: row.updated_at } : {}),
    };
  };

  r.put('/tenants/:tenantId/alerts', wrap(async (req, res) => {
    const tenantId = need(req, 'tenantId');
    const b = (req.body ?? {}) as { emails?: unknown; email?: unknown; webhookUrl?: unknown };
    const rawEmails = b.emails ?? b.email ?? [];
    const list: unknown[] = Array.isArray(rawEmails) ? rawEmails
      : typeof rawEmails === 'string' ? rawEmails.split(',') : [];
    if (!Array.isArray(rawEmails) && typeof rawEmails !== 'string') {
      throw new ApiError('ERR_SCHEMA_INVALID', 'emails must be an array of addresses or a comma-separated string');
    }
    const emails = list.map((e) => (typeof e === 'string' ? e.trim() : '')).filter(Boolean);
    const bad = emails.filter((e) => !EMAIL_RE.test(e));
    if (bad.length) throw new ApiError('ERR_SCHEMA_INVALID', `not an email address: ${bad.join(', ')}`);
    if (emails.length > 10) throw new ApiError('ERR_SCHEMA_INVALID', 'at most 10 alert emails');

    if (b.webhookUrl != null && typeof b.webhookUrl !== 'string') {
      throw new ApiError('ERR_SCHEMA_INVALID', 'webhookUrl must be a string or null');
    }
    const webhookUrl = b.webhookUrl ? b.webhookUrl : null;
    if (webhookUrl) {
      try { await validateWebhookUrl(webhookUrl, { allowHttp: d.cfg.NODE_ENV !== 'production' }); }
      catch (e) {
        if (e instanceof SsrfError) throw new ApiError('ERR_SCHEMA_INVALID', `webhookUrl: ${e.message}`);
        throw e;
      }
    }

    const existing = await alertView(tenantId);
    // A new secret only when the URL changes: re-saving the same settings must
    // not silently break a receiver that verifies signatures.
    const newSecret = webhookUrl && webhookUrl !== existing.webhookUrl
      ? `whsec_${randomBytes(32).toString('base64url')}` : null;
    const enc = newSecret ? encrypt(d.keys, newSecret, tenantId, 'alert_webhook_secret') : null;

    await withTenant(d.db, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO alert_settings (tenant_id, emails, webhook_url,
           webhook_secret_encrypted, webhook_secret_key_version, webhook_secret_iv, webhook_secret_tag)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id) DO UPDATE SET emails = EXCLUDED.emails, webhook_url = EXCLUDED.webhook_url,
           webhook_secret_encrypted = CASE WHEN EXCLUDED.webhook_url IS NULL THEN NULL
             ELSE COALESCE(EXCLUDED.webhook_secret_encrypted, alert_settings.webhook_secret_encrypted) END,
           webhook_secret_key_version = CASE WHEN EXCLUDED.webhook_url IS NULL THEN NULL
             ELSE COALESCE(EXCLUDED.webhook_secret_key_version, alert_settings.webhook_secret_key_version) END,
           webhook_secret_iv = CASE WHEN EXCLUDED.webhook_url IS NULL THEN NULL
             ELSE COALESCE(EXCLUDED.webhook_secret_iv, alert_settings.webhook_secret_iv) END,
           webhook_secret_tag = CASE WHEN EXCLUDED.webhook_url IS NULL THEN NULL
             ELSE COALESCE(EXCLUDED.webhook_secret_tag, alert_settings.webhook_secret_tag) END`,
        [tenantId, emails, webhookUrl, enc?.ciphertext ?? null, enc?.keyVersion ?? null,
         enc?.iv ?? null, enc?.tag ?? null]);
      await audit(tx, { tenantId, actor: 'admin', action: 'alerts.configure', resourceType: 'alert_settings',
        detail: { emails: emails.length, webhook: Boolean(webhookUrl) } });
    });

    const view = await alertView(tenantId);
    const warnings: string[] = [];
    if (emails.length && !d.cfg.ALERT_SMTP_HOST) {
      warnings.push('ALERT_SMTP_HOST is not configured: these emails are saved but no alert email will be sent until an SMTP outbox is set.');
    }
    res.json({
      ...view,
      ...(newSecret ? { webhookSecret: newSecret,
        secretNote: 'Shown once. Verify x-passo-signature with it, exactly as for CRM webhooks.' } : {}),
      ...(warnings.length ? { warnings } : {}),
      requestId: req.requestId,
    });
  }));

  r.get('/tenants/:tenantId/alerts', wrap(async (req, res) => {
    res.json({ ...(await alertView(need(req, 'tenantId'))), requestId: req.requestId });
  }));

  r.delete('/tenants/:tenantId/alerts', wrap(async (req, res) => {
    const tenantId = need(req, 'tenantId');
    await withTenant(d.db, tenantId, async (tx) => {
      await tx.query('DELETE FROM alert_settings WHERE tenant_id = $1', [tenantId]);
      await audit(tx, { tenantId, actor: 'admin', action: 'alerts.remove', resourceType: 'alert_settings' });
    });
    res.status(204).end();
  }));

  /** Send a test alert NOW and report each destination — the way to verify SMTP and webhooks. */
  r.post('/tenants/:tenantId/alerts/test', wrap(async (req, res) => {
    const tenantId = need(req, 'tenantId');
    const results = await sendTestAlert({ db: d.db, cfg: d.cfg, log: logger, keys: d.keys }, tenantId);
    res.json({
      sent: results.filter((x) => x.ok).length, failed: results.filter((x) => !x.ok).length, results,
      ...(results.length === 0 ? { note: 'No destination is configured: set this tenant\'s alert emails or webhook, or OPERATOR_ALERT_EMAIL / OPERATOR_ALERT_WEBHOOK_URL. Emails also need ALERT_SMTP_HOST.' } : {}),
      requestId: req.requestId,
    });
  }));

  /** Operator view: alerts across all tenants, open first. */
  r.get('/alerts', wrap(async (req, res) => {
    const status = asOptionalString(req.query['status']) === 'all' ? 'all' : 'open';
    const tenantId = asOptionalString(req.query['tenantId']);
    const rows = await withTx(d.db, async (tx) => {
      await tx.query('SET LOCAL ROLE passo_relay');
      return tx.query(
        `SELECT a.id, a.tenant_id AS "tenantId", t.slug AS "tenantSlug", a.kind, a.severity, a.channel,
                a.title, a.detail, a.occurrences, a.first_seen_at AS "firstSeenAt",
                a.last_seen_at AS "lastSeenAt", a.last_notified_at AS "lastNotifiedAt",
                a.resolved_at AS "resolvedAt"
           FROM alerts a LEFT JOIN tenants t ON t.id = a.tenant_id
          WHERE a.kind <> 'alert.test'
            AND ($1 = 'all' OR a.resolved_at IS NULL)
            AND ($2::uuid IS NULL OR a.tenant_id = $2::uuid)
          ORDER BY (a.resolved_at IS NULL) DESC, a.last_seen_at DESC LIMIT 200`,
        [status, tenantId ?? null]);
    });
    res.json({ data: rows.rows, requestId: req.requestId });
  }));

  return r;
}
