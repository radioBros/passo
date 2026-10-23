import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createHarness, seedTenant, validInvoice, ADMIN_KEY, testConfig, type Harness } from '../helpers/harness.ts';
import { withTx, withTenant } from '../../src/infra/db/pool.ts';
import {
  raiseAlert, resolveAlerts, dispatchAlerts, sendTestAlert, configureAlerts,
  type AlertDeps, type AlertSenders,
} from '../../src/domain/alert/service.ts';
import { verifyWebhook } from '../../src/domain/webhook/security.ts';
import { submitInvoice } from '../../src/domain/submission/service.ts';
import { startSubmitWorker } from '../../src/workers/submit.ts';
import { MockChannel } from '../../src/infra/channels/mock.ts';
import { ChannelError, type SdiChannelAdapter } from '../../src/infra/channels/types.ts';
import type { Broker, JobMessage } from '../../src/infra/queue/broker.ts';
import { QUEUES } from '../../src/infra/queue/topology.ts';
import { logger } from '../../src/shared/logger.ts';

/**
 * Alerts: problems that stop invoices reach a PERSON, by email and/or webhook,
 * instead of only a log line. Senders are stubbed; everything else — dedupe,
 * the cross-tenant dispatcher role, the outbox of deliveries — is real.
 */
let h: Harness;
let t = { tenantId: '', sellerId: '', apiKey: '' };
const OPERATOR_HOOK = 'https://1.1.1.1/operator-alerts';
const cfg = testConfig({
  ALERT_SMTP_HOST: 'smtp.example.test', ALERT_FROM: 'passo@example.test',
  OPERATOR_ALERT_EMAIL: 'ops@example.test', OPERATOR_ALERT_WEBHOOK_URL: OPERATOR_HOOK,
  OPERATOR_ALERT_WEBHOOK_SECRET: 'whsec_operator_test_secret',
});
let deps: AlertDeps;

const sent: Array<{ kind: 'email' | 'webhook'; to: string; subject?: string; text?: string;
  body?: string; headers?: Record<string, string> }> = [];
let webhookStatus = 200;
const senders: AlertSenders = {
  async email(_c, to, msg) { sent.push({ kind: 'email', to, ...msg }); },
  async webhook(url, body, headers) { sent.push({ kind: 'webhook', to: url, body, headers }); return webhookStatus; },
};

const relay = <T>(fn: (q: (sql: string, p?: unknown[]) => Promise<{ rows: T[] }>) => Promise<{ rows: T[] }>) =>
  withTx(h.db, async (tx) => {
    await tx.query('SET LOCAL ROLE passo_relay');
    return fn((sql, p) => tx.query(sql, p) as unknown as Promise<{ rows: T[] }>);
  });

const openAlerts = async (tenantId: string | null, kind: string) => (await relay<{
  id: string; occurrences: number; resolved_at: Date | null; last_notified_at: Date | null;
}>((q) => q(`SELECT id, occurrences, resolved_at, last_notified_at FROM alerts
             WHERE tenant_id IS NOT DISTINCT FROM $1 AND kind = $2 ORDER BY first_seen_at`, [tenantId, kind]))).rows;

const deliveriesFor = async (alertId: string) => (await relay<{
  event: string; destination: string; scope: string; target: string; state: string; attempts: number; last_error: string | null;
}>((q) => q('SELECT event, destination, scope, target, state, attempts, last_error FROM alert_deliveries WHERE alert_id = $1 ORDER BY id', [alertId]))).rows;

beforeAll(async () => {
  h = createHarness({
    ALERT_SMTP_HOST: '', OPERATOR_ALERT_EMAIL: '', OPERATOR_ALERT_WEBHOOK_URL: '',
  });
  deps = { db: h.db, cfg, log: logger, keys: h.keys };
  t = await seedTenant(h);
});
afterEach(() => { sent.length = 0; webhookStatus = 200; configureAlerts(null); });
afterAll(async () => { await h.close(); });

describe('raising', () => {
  it('a repeat is COUNTED, not re-sent', async () => {
    const tt = await seedTenant(h);
    await raiseAlert(deps, { tenantId: tt.tenantId, kind: 'channel.credit_exhausted', channel: 'openapi' });
    await raiseAlert(deps, { tenantId: tt.tenantId, kind: 'channel.credit_exhausted', channel: 'openapi' });
    const a = await openAlerts(tt.tenantId, 'channel.credit_exhausted');
    expect(a).toHaveLength(1);
    expect(a[0]!.occurrences).toBe(2);
    // One notification: the operator email + the operator webhook (the tenant set none).
    const d = await deliveriesFor(a[0]!.id);
    expect(d.map((x) => `${x.scope}:${x.destination}`).sort()).toEqual(['operator:email', 'operator:webhook']);
  });

  /** A plain unique index treats NULLs as distinct — a system alert would never dedupe. */
  it('a SYSTEM alert (no tenant, no channel) dedupes too', async () => {
    await relay((q) => q(`UPDATE alerts SET resolved_at = now() WHERE kind = 'system.audit_chain_broken' AND resolved_at IS NULL`));
    await raiseAlert(deps, { tenantId: null, kind: 'system.audit_chain_broken', channel: null });
    await raiseAlert(deps, { tenantId: null, kind: 'system.audit_chain_broken', channel: null });
    const open = (await openAlerts(null, 'system.audit_chain_broken')).filter((x) => !x.resolved_at);
    expect(open).toHaveLength(1);
    expect(open[0]!.occurrences).toBe(2);
  });

  it('concurrent raisers create ONE alert and notify ONCE', async () => {
    const tt = await seedTenant(h);
    await Promise.all(Array.from({ length: 8 }, () =>
      raiseAlert(deps, { tenantId: tt.tenantId, kind: 'pec.poll_failed', channel: 'pec' })));
    const a = await openAlerts(tt.tenantId, 'pec.poll_failed');
    expect(a).toHaveLength(1);
    expect(a[0]!.occurrences).toBe(8);
    expect((await deliveriesFor(a[0]!.id)).filter((x) => x.event === 'alert.firing')).toHaveLength(2);
  });

  it('notifies AGAIN once the repeat window has passed', async () => {
    const tt = await seedTenant(h);
    await raiseAlert(deps, { tenantId: tt.tenantId, kind: 'channel.auth_failed', channel: 'openapi' });
    const [a] = await openAlerts(tt.tenantId, 'channel.auth_failed');
    await relay((q) => q(`UPDATE alerts SET last_notified_at = now() - interval '7 hours' WHERE id = $1`, [a!.id]));
    await raiseAlert(deps, { tenantId: tt.tenantId, kind: 'channel.auth_failed', channel: 'openapi' });
    expect((await deliveriesFor(a!.id)).filter((x) => x.event === 'alert.firing')).toHaveLength(4);
  });

  it('resolving announces it only where a "firing" went out', async () => {
    const tt = await seedTenant(h);
    await raiseAlert(deps, { tenantId: tt.tenantId, kind: 'channel.setup_required', channel: 'openapi' });
    await resolveAlerts(deps, { tenantId: tt.tenantId, channel: 'openapi', kinds: ['channel.setup_required'] });
    const [a] = await openAlerts(tt.tenantId, 'channel.setup_required');
    expect(a!.resolved_at).not.toBeNull();
    expect((await deliveriesFor(a!.id)).filter((x) => x.event === 'alert.resolved')).toHaveLength(2);
    // A fresh occurrence after resolution is a NEW alert.
    await raiseAlert(deps, { tenantId: tt.tenantId, kind: 'channel.setup_required', channel: 'openapi' });
    expect(await openAlerts(tt.tenantId, 'channel.setup_required')).toHaveLength(2);
  });

  it('never throws into the caller, even when the database refuses', async () => {
    const broken: AlertDeps = { ...deps, db: { connect: async () => { throw new Error('db down'); } } as never };
    await expect(raiseAlert(broken, { tenantId: null, kind: 'system.ingress_stalled' })).resolves.toBeUndefined();
  });
});

describe('dispatching', () => {
  it('sends email with the remedy, and a SIGNED webhook', async () => {
    const tt = await seedTenant(h);
    await raiseAlert(deps, { tenantId: tt.tenantId, kind: 'channel.credit_exhausted', channel: 'openapi',
      detail: { latestSubmissionId: 'sub-1' } });
    await dispatchAlerts(deps, senders);
    const mail = sent.find((x) => x.kind === 'email' && x.to === 'ops@example.test')!;
    expect(mail.subject).toMatch(/CRITICAL: SdI channel account is out of credit/);
    expect(mail.text).toMatch(/What to do: Top up the vendor account/);
    const hook = sent.find((x) => x.kind === 'webhook' && x.to === OPERATOR_HOOK)!;
    expect(hook.headers!['x-passo-event']).toBe('alert.firing');
    expect(verifyWebhook(hook.body!, hook.headers!['x-passo-signature']!, 'whsec_operator_test_secret'),
      'operator webhook is signed with OPERATOR_ALERT_WEBHOOK_SECRET').toBe(true);
    const payload = JSON.parse(hook.body!) as { alert: { kind: string; remedy: string } };
    expect(payload.alert.kind).toBe('channel.credit_exhausted');
    expect(payload.alert.remedy).toMatch(/Top up/);
  });

  it('a failing destination is retried with backoff, then marked failed', async () => {
    const tt = await seedTenant(h);
    await raiseAlert(deps, { tenantId: tt.tenantId, kind: 'webhook.delivery_failed' });
    const [a] = await openAlerts(tt.tenantId, 'webhook.delivery_failed');
    webhookStatus = 500;
    const ids = (await relay<{ id: string }>((q) => q(`SELECT id FROM alert_deliveries WHERE alert_id = $1 AND destination = 'webhook'`, [a!.id]))).rows.map((r) => Number(r.id));
    await dispatchAlerts(deps, senders, ids);
    let d = (await deliveriesFor(a!.id)).find((x) => x.destination === 'webhook')!;
    expect(d.state).toBe('pending');
    expect(d.last_error).toBe('HTTP 500');
    await relay((q) => q('UPDATE alert_deliveries SET attempts = 8 WHERE id = ANY($1::bigint[])', [ids]));
    await dispatchAlerts(deps, senders, ids);
    d = (await deliveriesFor(a!.id)).find((x) => x.destination === 'webhook')!;
    expect(d.state).toBe('failed');
  });
});

describe('admin API', () => {
  const admin = { authorization: `Bearer ${ADMIN_KEY}` };

  it('saves emails, and WARNS when no SMTP outbox is configured', async () => {
    const r = await request(h.app).put(`/api/v1/admin/tenants/${t.tenantId}/alerts`)
      .set(admin).send({ emails: ['billing@acme.example', 'cto@acme.example'] });
    expect(r.status).toBe(200);
    expect(r.body.emails).toEqual(['billing@acme.example', 'cto@acme.example']);
    expect(r.body.warnings?.[0]).toMatch(/ALERT_SMTP_HOST is not configured/);
  });

  it('refuses an alert webhook pointing at a private address (SSRF)', async () => {
    const r = await request(h.app).put(`/api/v1/admin/tenants/${t.tenantId}/alerts`)
      .set(admin).send({ webhookUrl: 'https://169.254.169.254/latest' });
    expect(r.status).toBe(400);
  });

  it('returns a signing secret ONCE, and keeps it when settings are re-saved', async () => {
    const tt = await seedTenant(h);
    const first = await request(h.app).put(`/api/v1/admin/tenants/${tt.tenantId}/alerts`)
      .set(admin).send({ webhookUrl: 'https://1.1.1.1/tenant-alerts' });
    expect(first.body.webhookSecret).toMatch(/^whsec_/);
    const again = await request(h.app).put(`/api/v1/admin/tenants/${tt.tenantId}/alerts`)
      .set(admin).send({ webhookUrl: 'https://1.1.1.1/tenant-alerts', emails: 'a@b.example' });
    expect(again.body.webhookSecret, 'same URL: the existing secret is kept').toBeUndefined();
    const get = await request(h.app).get(`/api/v1/admin/tenants/${tt.tenantId}/alerts`).set(admin);
    expect(get.body).toMatchObject({ webhookUrl: 'https://1.1.1.1/tenant-alerts', webhookSigned: true });
    expect(JSON.stringify(get.body)).not.toMatch(/whsec_/);

    // The tenant webhook is signed with THAT secret.
    await raiseAlert(deps, { tenantId: tt.tenantId, kind: 'pec.poll_failed', channel: 'pec' });
    await dispatchAlerts(deps, senders);
    const hook = sent.find((x) => x.kind === 'webhook' && x.to === 'https://1.1.1.1/tenant-alerts')!;
    expect(verifyWebhook(hook.body!, hook.headers!['x-passo-signature']!, first.body.webhookSecret as string)).toBe(true);
  });

  it('the test endpoint reports when there is nowhere to send', async () => {
    const tt = await seedTenant(h);
    const r = await request(h.app).post(`/api/v1/admin/tenants/${tt.tenantId}/alerts/test`).set(admin);
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([]);
    expect(r.body.note).toMatch(/No destination is configured/);
  });

  it('a test alert reaches every destination and reports each', async () => {
    const tt = await seedTenant(h);
    await withTenant(h.db, tt.tenantId, (tx) => tx.query(
      `INSERT INTO alert_settings (tenant_id, emails) VALUES ($1, '{billing@acme.example}')`, [tt.tenantId]));
    const results = await sendTestAlert(deps, tt.tenantId, senders);
    expect(results.map((x) => `${x.destination}:${x.target}`).sort()).toEqual([
      'email:billing@acme.example', 'email:ops@example.test', `webhook:${OPERATOR_HOOK}`]);
    expect(results.every((x) => x.ok)).toBe(true);
  });

  it('a tenant cannot read another tenant\'s alert settings (RLS)', async () => {
    const other = await seedTenant(h);
    const r = await withTenant(h.db, other.tenantId, (tx) => tx.query(
      'SELECT 1 FROM alert_settings WHERE tenant_id = $1', [t.tenantId]));
    expect(r.rowCount).toBe(0);
  });
});

describe('from the submit worker', () => {
  const fakeBroker = () => {
    const handlers = new Map<string, (m: JobMessage) => Promise<void>>();
    const broker = {
      publish: () => true, publishConfirmed: async () => true,
      consume: async (q: string, fn: (m: JobMessage) => Promise<void>) => { handlers.set(q, fn); },
      close: async () => undefined,
    } as unknown as Broker;
    return { broker, deliver: (q: string, m: JobMessage) => handlers.get(q)!(m) };
  };

  it('an empty wallet raises a credit alert, and the next successful send resolves it', async () => {
    configureAlerts(deps);
    const tt = await seedTenant(h);
    let calls = 0;
    const adapter: SdiChannelAdapter = {
      name: 'openapi',
      capabilities: { serverSideSigning: true, pushNotifications: true, maxMessageBytes: 1e9 },
      submit: async () => {
        calls++;
        if (calls === 1) throw new ChannelError('out of credit', true, 'ERR_CHANNEL_CREDIT', 'not_sent');
        return { channelRef: 'ok', acceptedAt: new Date() };
      },
      willSign: () => true,
    };
    const f = fakeBroker();
    await startSubmitWorker(h.db, f.broker, h.keys, logger, async () => ({ adapter, config: {} }));
    const s = await submitInvoice(h.db, h.keys, validInvoice(), {
      tenantId: tt.tenantId, sellerId: tt.sellerId, channel: new MockChannel(),
    });
    const msg = { tenantId: tt.tenantId, attempt: 0, payload: { submissionId: s.submissionId } };
    await f.deliver(QUEUES.submit, msg);
    const [a] = await openAlerts(tt.tenantId, 'channel.credit_exhausted');
    expect(a, 'a person is told').toBeTruthy();
    expect(a!.resolved_at).toBeNull();

    await f.deliver(QUEUES.submit, { ...msg, attempt: 1 });
    expect((await openAlerts(tt.tenantId, 'channel.credit_exhausted'))[0]!.resolved_at,
      'the next successful send closes it').not.toBeNull();
  });
});
