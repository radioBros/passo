import nodemailer, { type Transporter } from 'nodemailer';
import { fetch as undiciFetch } from 'undici';
import type { Db, Tx } from '../../infra/db/pool.ts';
import { withTx } from '../../infra/db/pool.ts';
import { decryptString, type KeyProvider } from '../../infra/crypto/keys.ts';
import { signWebhook, validateWebhookUrl, pinnedDispatcher } from '../webhook/security.ts';
import type { Config } from '../../shared/config.ts';
import type { Logger } from '../../shared/logger.ts';
import { ALERT_KINDS, type AlertKindName } from './kinds.ts';

/**
 * Alerts: raise, resolve, and dispatch.
 *
 * Every function here runs as `passo_relay`: an alert can belong to any tenant
 * (or none), and the dispatcher serves all of them. Raising is BEST EFFORT and
 * never throws — it is called from failure paths (the submit worker's catch
 * block, the pollers), where an exception would change retry behaviour.
 */
export interface AlertDeps { db: Db; cfg: Config; log: Logger; keys: KeyProvider }

type Event = 'alert.firing' | 'alert.resolved' | 'alert.test';

const asRelay = <T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withTx(db, async (tx) => { await tx.query('SET LOCAL ROLE passo_relay'); return fn(tx); });

const splitList = (s: string): string[] =>
  s.split(',').map((x) => x.trim()).filter(Boolean);

/** Bound and sanitise free text that came from a vendor before it leaves PASSO. */
export const sanitize = (v: unknown, max = 300): string =>
  (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v)).replace(/[\r\n\t]+/g, ' ').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, max);

/**
 * Where an alert goes: the tenant's own destinations (if it is a tenant
 * alert), plus the operator's. Email is only queued when an SMTP outbox is
 * configured — the admin API warns about that when emails are saved.
 */
async function destinations(
  tx: Tx, cfg: Config, tenantId: string | null, scope: 'tenant' | 'system',
): Promise<Array<{ destination: 'email' | 'webhook'; scope: 'tenant' | 'operator'; target: string }>> {
  const out: Array<{ destination: 'email' | 'webhook'; scope: 'tenant' | 'operator'; target: string }> = [];
  const smtp = Boolean(cfg.ALERT_SMTP_HOST);
  if (scope === 'tenant' && tenantId) {
    const s = await tx.query<{ emails: string[]; webhook_url: string | null }>(
      'SELECT emails, webhook_url FROM alert_settings WHERE tenant_id = $1', [tenantId]);
    const row = s.rows[0];
    if (row && smtp) for (const e of row.emails) out.push({ destination: 'email', scope: 'tenant', target: e });
    if (row?.webhook_url) out.push({ destination: 'webhook', scope: 'tenant', target: row.webhook_url });
  }
  if (smtp) for (const e of splitList(cfg.OPERATOR_ALERT_EMAIL)) out.push({ destination: 'email', scope: 'operator', target: e });
  if (cfg.OPERATOR_ALERT_WEBHOOK_URL) out.push({ destination: 'webhook', scope: 'operator', target: cfg.OPERATOR_ALERT_WEBHOOK_URL });
  return out;
}

async function queueDeliveries(
  tx: Tx, cfg: Config, alertId: string, tenantId: string | null, scope: 'tenant' | 'system', event: Event,
): Promise<number> {
  const ds = await destinations(tx, cfg, tenantId, scope);
  for (const d of ds) {
    await tx.query(
      `INSERT INTO alert_deliveries (alert_id, tenant_id, event, destination, scope, target)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [alertId, tenantId, event, d.destination, d.scope, d.target]);
  }
  return ds.length;
}

export interface RaiseInput {
  tenantId: string | null;
  kind: AlertKindName;
  channel?: string | null;
  detail?: Record<string, unknown>;
}

/**
 * Raise (or re-raise) an alert. One OPEN row per (tenant, kind, channel):
 * a repeat increments `occurrences` instead of creating a new alert, and a
 * notification goes out on the first occurrence and then at most once per
 * ALERT_REPEAT_MINUTES while it persists.
 */
export async function raiseAlert(d: AlertDeps, a: RaiseInput): Promise<void> {
  const k = ALERT_KINDS[a.kind];
  try {
    await asRelay(d.db, async (tx) => {
      const r = await tx.query<{ id: string }>(
        `INSERT INTO alerts (tenant_id, kind, severity, channel, title, detail)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, kind, channel) WHERE resolved_at IS NULL
         DO UPDATE SET occurrences = alerts.occurrences + 1, last_seen_at = now(),
                       detail = EXCLUDED.detail
         RETURNING id`,
        [a.tenantId, a.kind, k.severity, a.channel ?? null, k.title, JSON.stringify(a.detail ?? {})]);
      const id = r.rows[0]!.id;
      // Conditional, so concurrent raisers notify once, not once each.
      const due = await tx.query(
        `UPDATE alerts SET last_notified_at = now()
          WHERE id = $1 AND (last_notified_at IS NULL
                OR last_notified_at < now() - ($2 || ' minutes')::interval)
          RETURNING id`, [id, String(d.cfg.ALERT_REPEAT_MINUTES)]);
      if (due.rowCount) {
        const n = await queueDeliveries(tx, d.cfg, id, a.tenantId, k.scope, 'alert.firing');
        d.log.warn({ alertId: id, kind: a.kind, tenantId: a.tenantId, channel: a.channel, destinations: n },
          `ALERT ${k.severity.toUpperCase()}: ${k.title}`);
      }
    });
  } catch (err) {
    d.log.error({ err, kind: a.kind, tenantId: a.tenantId }, 'could not record alert');
  }
}

/** Close open alerts a success proves are over; announce it only where a "firing" went out. */
export async function resolveAlerts(
  d: AlertDeps, r: { tenantId: string | null; channel?: string | null; kinds: readonly AlertKindName[] },
): Promise<void> {
  try {
    await asRelay(d.db, async (tx) => {
      const closed = await tx.query<{ id: string; kind: AlertKindName; last_notified_at: Date | null }>(
        `UPDATE alerts SET resolved_at = now()
          WHERE tenant_id IS NOT DISTINCT FROM $1 AND channel IS NOT DISTINCT FROM $2
            AND kind = ANY($3::text[]) AND resolved_at IS NULL
          RETURNING id, kind, last_notified_at`,
        [r.tenantId, r.channel ?? null, [...r.kinds]]);
      for (const a of closed.rows) {
        if (a.last_notified_at) {
          await queueDeliveries(tx, d.cfg, a.id, r.tenantId, ALERT_KINDS[a.kind].scope, 'alert.resolved');
        }
        d.log.info({ alertId: a.id, kind: a.kind, tenantId: r.tenantId }, 'alert resolved');
      }
    });
  } catch (err) {
    d.log.error({ err, tenantId: r.tenantId }, 'could not resolve alerts');
  }
}

// ---------------------------------------------------------------- rendering

export interface AlertRow {
  id: string; tenant_id: string | null; tenant_slug: string | null; tenant_name: string | null;
  kind: AlertKindName; severity: string; channel: string | null; title: string;
  detail: Record<string, unknown>; occurrences: number; first_seen_at: Date; last_seen_at: Date;
}

export function renderPayload(a: AlertRow, event: Event): Record<string, unknown> {
  const k = ALERT_KINDS[a.kind];
  return {
    event, sentAt: new Date().toISOString(),
    alert: {
      id: a.id, kind: a.kind, severity: a.severity,
      status: event === 'alert.resolved' ? 'resolved' : 'firing',
      title: a.title, impact: k.impact, remedy: k.remedy,
      tenant: a.tenant_id ? { id: a.tenant_id, slug: a.tenant_slug, name: a.tenant_name } : null,
      channel: a.channel, occurrences: a.occurrences,
      firstSeenAt: a.first_seen_at, lastSeenAt: a.last_seen_at, detail: a.detail,
    },
  };
}

export function renderEmail(a: AlertRow, event: Event): { subject: string; text: string } {
  const k = ALERT_KINDS[a.kind];
  const who = a.tenant_slug ? ` — ${a.tenant_slug}` : '';
  const status = event === 'alert.resolved' ? 'RESOLVED' : a.severity.toUpperCase();
  const lines = [
    event === 'alert.resolved' ? `RESOLVED: ${a.title}` : a.title, '',
    ...(event === 'alert.resolved' ? ['This problem is no longer occurring.', ''] : [
      `What it means: ${k.impact}`, '', `What to do: ${k.remedy}`, '']),
    ...(a.tenant_id ? [`Tenant:      ${a.tenant_name ?? ''} (${a.tenant_slug ?? ''}, ${a.tenant_id})`] : []),
    ...(a.channel ? [`Channel:     ${a.channel}`] : []),
    `Occurrences: ${a.occurrences}`,
    `First seen:  ${new Date(a.first_seen_at).toISOString()}`,
    `Last seen:   ${new Date(a.last_seen_at).toISOString()}`,
    ...Object.entries(a.detail ?? {}).map(([key, v]) => `${key}: ${sanitize(v)}`),
    '', `Alert ${a.id} · kind ${a.kind}`,
  ];
  return { subject: `[PASSO] ${status}: ${a.title}${who}`, text: lines.join('\n') };
}

// --------------------------------------------------------------- dispatching

export interface AlertSenders {
  email(cfg: Config, to: string, msg: { subject: string; text: string }): Promise<void>;
  webhook(url: string, body: string, headers: Record<string, string>, allowHttp: boolean): Promise<number>;
}

let transport: Transporter | null = null;
let transportKey = '';

export const defaultSenders: AlertSenders = {
  async email(cfg, to, msg) {
    const key = `${cfg.ALERT_SMTP_HOST}:${cfg.ALERT_SMTP_PORT}:${cfg.ALERT_SMTP_USER}`;
    if (!transport || key !== transportKey) {
      transport = nodemailer.createTransport({
        host: cfg.ALERT_SMTP_HOST, port: cfg.ALERT_SMTP_PORT,
        // TLS always: implicit on 465, STARTTLS required elsewhere. There is
        // deliberately no switch to send alerts (and credentials) in clear.
        secure: cfg.ALERT_SMTP_PORT === 465, requireTLS: cfg.ALERT_SMTP_PORT !== 465,
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
        ...(cfg.ALERT_SMTP_USER ? { auth: { user: cfg.ALERT_SMTP_USER, pass: cfg.ALERT_SMTP_PASSWORD } } : {}),
      });
      transportKey = key;
    }
    await transport.sendMail({ from: cfg.ALERT_FROM || cfg.ALERT_SMTP_USER, to, ...msg });
  },
  async webhook(url, body, headers, allowHttp) {
    // The same SSRF defence as CRM webhooks: validated at save time AND here,
    // and the connection pinned to the address that was validated.
    const v = await validateWebhookUrl(url, { allowHttp });
    const res = await undiciFetch(v.url, {
      dispatcher: pinnedDispatcher(v.ip), method: 'POST', headers, body,
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    return res.status;
  },
};

const MAX_ATTEMPTS = 8;
const backoffMinutes = (attempt: number): number => Math.min(2 ** attempt, 240);

/** Send one delivery. Returns an error message, or null when it went out. */
async function sendOne(
  d: AlertDeps, senders: AlertSenders,
  row: AlertRow & { event: Event; destination: 'email' | 'webhook'; scope: 'tenant' | 'operator'; target: string },
  tenantSecret: string | null,
): Promise<string | null> {
  try {
    if (row.destination === 'email') {
      if (!d.cfg.ALERT_SMTP_HOST) return 'ALERT_SMTP_HOST is not configured';
      await senders.email(d.cfg, row.target, renderEmail(row, row.event));
      return null;
    }
    const body = JSON.stringify(renderPayload(row, row.event));
    const secret = row.scope === 'operator' ? d.cfg.OPERATOR_ALERT_WEBHOOK_SECRET : tenantSecret;
    const headers: Record<string, string> = {
      'content-type': 'application/json', 'x-passo-event': row.event, 'x-passo-alert-id': row.id,
      ...(secret ? { 'x-passo-signature': signWebhook(body, secret) } : {}),
    };
    const status = await senders.webhook(row.target, body, headers, d.cfg.NODE_ENV !== 'production');
    return status >= 200 && status < 300 ? null : `HTTP ${status}`;
  } catch (e) {
    return sanitize((e as Error).message);
  }
}

/**
 * Send what is due. Rows are LEASED (next_attempt_at pushed out) before any
 * network I/O, so a slow SMTP server never holds row locks, and two worker
 * replicas never send the same delivery.
 */
export async function dispatchAlerts(
  d: AlertDeps, senders: AlertSenders = defaultSenders, only?: number[],
): Promise<Array<{ id: number; destination: string; target: string; ok: boolean; error?: string }>> {
  const leased = await asRelay(d.db, (tx) => tx.query<AlertRow & {
    delivery_id: number; event: Event; destination: 'email' | 'webhook';
    scope: 'tenant' | 'operator'; target: string; attempts: number;
    secret_encrypted: Buffer | null; secret_iv: Buffer | null; secret_tag: Buffer | null; secret_key_version: string | null;
  }>(
    `WITH due AS (
       SELECT id FROM alert_deliveries
        WHERE state = 'pending' AND (($1::bigint[] IS NULL AND next_attempt_at <= now()) OR id = ANY($1::bigint[]))
        ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED)
     UPDATE alert_deliveries ad SET attempts = ad.attempts + 1, next_attempt_at = now() + interval '5 minutes'
       FROM due WHERE ad.id = due.id
     RETURNING ad.id AS delivery_id, ad.event, ad.destination, ad.scope, ad.target, ad.attempts,
       (SELECT row_to_json(x) FROM (
          SELECT a.id, a.tenant_id, t.slug AS tenant_slug, t.name AS tenant_name, a.kind, a.severity,
                 a.channel, a.title, a.detail, a.occurrences, a.first_seen_at, a.last_seen_at,
                 s.webhook_secret_encrypted AS secret_encrypted, s.webhook_secret_iv AS secret_iv,
                 s.webhook_secret_tag AS secret_tag, s.webhook_secret_key_version AS secret_key_version
            FROM alerts a LEFT JOIN tenants t ON t.id = a.tenant_id
            LEFT JOIN alert_settings s ON s.tenant_id = a.tenant_id
           WHERE a.id = ad.alert_id) x) AS alert`,
    [only ?? null]));

  const results: Array<{ id: number; destination: string; target: string; ok: boolean; error?: string }> = [];
  for (const raw of leased.rows) {
    const a = (raw as unknown as { alert: Record<string, unknown> }).alert;
    const row = {
      ...(a as unknown as AlertRow), event: raw.event, destination: raw.destination,
      scope: raw.scope, target: raw.target,
    };
    let secret: string | null = null;
    if (raw.destination === 'webhook' && raw.scope === 'tenant' && a['secret_encrypted']) {
      try {
        const hex = (v: unknown) => Buffer.from(String(v).replace(/^\\x/, ''), 'hex');
        secret = decryptString(d.keys, {
          ciphertext: hex(a['secret_encrypted']), iv: hex(a['secret_iv']), tag: hex(a['secret_tag']),
          keyVersion: String(a['secret_key_version']),
        }, String(a['tenant_id']), 'alert_webhook_secret');
      } catch { /* sent unsigned rather than not at all; the receiver can reject it */ }
    }
    const error = await sendOne(d, senders, row, secret);
    await asRelay(d.db, (tx) => tx.query(
      error === null
        ? `UPDATE alert_deliveries SET state = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`
        : `UPDATE alert_deliveries SET last_error = $2,
             state = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
             next_attempt_at = now() + ($4 || ' minutes')::interval
           WHERE id = $1`,
      error === null ? [raw.delivery_id]
        : [raw.delivery_id, error, MAX_ATTEMPTS, String(backoffMinutes(raw.attempts))]));
    if (error) d.log.warn({ deliveryId: raw.delivery_id, destination: raw.destination, error }, 'alert delivery failed');
    results.push({ id: raw.delivery_id, destination: raw.destination, target: raw.target,
                   ok: error === null, ...(error ? { error } : {}) });
  }
  return results;
}

export function startAlertDispatcher(
  d: AlertDeps, senders: AlertSenders = defaultSenders,
): { stop: () => void; tick: () => Promise<void> } {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try { await dispatchAlerts(d, senders); }
    catch (err) { d.log.error({ err }, 'alert dispatch tick failed'); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, d.cfg.ALERT_DISPATCH_INTERVAL_MS);
  return { stop: () => clearInterval(timer), tick };
}

/**
 * Send a test alert to a tenant's destinations (and the operator's) NOW, and
 * report per destination — so an operator can verify SMTP and webhook
 * settings without waiting for a real failure.
 */
export async function sendTestAlert(d: AlertDeps, tenantId: string, senders: AlertSenders = defaultSenders) {
  const ids = await asRelay(d.db, async (tx) => {
    const a = await tx.query<{ id: string }>(
      `INSERT INTO alerts (tenant_id, kind, severity, channel, title, detail, resolved_at, last_notified_at)
       VALUES ($1, 'alert.test', 'warning', NULL, $2, '{}'::jsonb, now(), now()) RETURNING id`,
      [tenantId, ALERT_KINDS['alert.test'].title]);
    await queueDeliveries(tx, d.cfg, a.rows[0]!.id, tenantId, 'tenant', 'alert.test');
    const q = await tx.query<{ id: number }>(
      'SELECT id FROM alert_deliveries WHERE alert_id = $1 ORDER BY id', [a.rows[0]!.id]);
    return q.rows.map((r) => Number(r.id));
  });
  return ids.length ? dispatchAlerts(d, senders, ids) : [];
}

// ------------------------------------------------------------- process sink

/**
 * The process-wide sink failure sites call. Configured once at boot; until
 * then (and in tests that do not configure it) alerting is a no-op, so a
 * failure path never depends on alerting being available.
 */
let sink: AlertDeps | null = null;
export function configureAlerts(d: AlertDeps | null): void { sink = d; }

export function alert(a: RaiseInput): Promise<void> {
  return sink ? raiseAlert(sink, a) : Promise.resolve();
}
export function resolved(r: { tenantId: string | null; channel?: string | null; kinds: readonly AlertKindName[] }): Promise<void> {
  return sink ? resolveAlerts(sink, r) : Promise.resolve();
}
