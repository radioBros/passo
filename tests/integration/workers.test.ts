import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHarness, seedTenant, validInvoice, type Harness } from '../helpers/harness.ts';
import { withTenant } from '../../src/infra/db/pool.ts';
import { submitInvoice, retrySubmission } from '../../src/domain/submission/service.ts';
import { startSubmitWorker } from '../../src/workers/submit.ts';
import { startWebhookWorker } from '../../src/workers/webhook.ts';
import type { Broker, JobMessage } from '../../src/infra/queue/broker.ts';
import { MockChannel } from '../../src/infra/channels/mock.ts';
import { ChannelError, type SdiChannelAdapter } from '../../src/infra/channels/types.ts';
import { channelForTenant } from '../../src/infra/channels/registry.ts';
import { logger } from '../../src/shared/logger.ts';
import { STATE } from '../../src/domain/submission/state.ts';
import { EXCHANGES, QUEUES } from '../../src/infra/queue/topology.ts';

let h: Harness;
let t: Awaited<ReturnType<typeof seedTenant>>;

/**
 * Workers are driven through an IN-MEMORY broker rather than the real one.
 *
 * The `passo` stack runs its own worker container consuming the same queues, so
 * a test publishing to RabbitMQ races it — and that container holds a different
 * encryption key, so it cannot decrypt test rows anyway. Driving the handler
 * directly tests the worker's own logic deterministically; the real broker is
 * covered separately in broker.test.ts.
 */
function fakeBroker() {
  const handlers = new Map<string, (m: JobMessage) => Promise<void>>();
  const published: Array<{ exchange: string; key: string; body: unknown }> = [];
  const broker: Broker = {
    publish(exchange, key, body) { published.push({ exchange, key, body }); return true; },
    publishConfirmed(exchange, key, body) {
      published.push({ exchange, key, body }); return Promise.resolve(true);
    },
    async consume(q, handler) { handlers.set(q, handler as never); },
    async close() { /* nothing to close */ },
  };
  return {
    broker, published,
    deliver: (q: string, msg: JobMessage) => handlers.get(q)!(msg),
  };
}

beforeAll(async () => {
  h = createHarness();
  t = await seedTenant(h);
});
afterAll(async () => { await h.close(); });

const stateOf = async (id: string) => {
  const r = await withTenant(h.db, t.tenantId, (tx) =>
    tx.query<{ state: string }>('SELECT state FROM sdi_submissions WHERE id=$1', [id]));
  return r.rows[0]?.state;
};

describe('submit worker', () => {
  it('transmits a queued submission and records identificativoSdI', async () => {
    const f = fakeBroker();
    await startSubmitWorker(h.db, f.broker, h.keys, logger,
      (id) => channelForTenant(h.db, h.keys, id));
    const s = await submitInvoice(h.db, h.keys, validInvoice(), {
      tenantId: t.tenantId, sellerId: t.sellerId, channel: new MockChannel(),
    });
    await f.deliver(QUEUES.submit, {
      tenantId: t.tenantId, attempt: 0, payload: { submissionId: s.submissionId },
    });
    expect(await stateOf(s.submissionId)).toBe(STATE.transmitted);

    const row = await withTenant(h.db, t.tenantId, (tx) => tx.query<{ identificativo_sdi: string | null }>(
      'SELECT identificativo_sdi FROM sdi_submissions WHERE id=$1', [s.submissionId]));
    expect(row.rows[0]!.identificativo_sdi).toBeTruthy();
  });

  it('marks a submission failed after a NON-retryable channel error', async () => {
    const failing: SdiChannelAdapter = {
      name: 'mock',
      capabilities: { serverSideSigning: true, pushNotifications: false, maxMessageBytes: 1e9 },
      submit: async () => { throw new ChannelError('bad credentials', false, 'ERR_CHANNEL_AUTH'); },
      willSign: () => true,
    };
    const f = fakeBroker();
    await startSubmitWorker(h.db, f.broker, h.keys, logger, async () => ({ adapter: failing, config: {} }));
    const s = await submitInvoice(h.db, h.keys, validInvoice(), {
      tenantId: t.tenantId, sellerId: t.sellerId, channel: new MockChannel(),
    });
    // The worker rethrows so the message dead-letters; the state change is what matters.
    await f.deliver(QUEUES.submit, {
      tenantId: t.tenantId, attempt: 0, payload: { submissionId: s.submissionId },
    }).catch(() => undefined);
    expect(await stateOf(s.submissionId)).toBe(STATE.failed);
  });

  /**
   * Stage 2 of the signing gate. Acceptance checked the configuration as it
   * was; if signing is switched off before the worker runs, the invoice must
   * NOT go to SdI unsigned — it fails permanently and is never transmitted.
   */
  it('REFUSES to transmit B2G when the vendor will no longer sign', async () => {
    let transmitted = 0;
    const noSigning: SdiChannelAdapter = {
      name: 'openapi',
      capabilities: { serverSideSigning: true, pushNotifications: true, maxMessageBytes: 1e9 },
      submit: async () => { transmitted++; return { acceptedAt: new Date() }; },
      willSign: () => false,
    };
    const f = fakeBroker();
    await startSubmitWorker(h.db, f.broker, h.keys, logger,
      async () => ({ adapter: noSigning, config: {} }));
    const s = await submitInvoice(h.db, h.keys,
      validInvoice({ format: 'FPA12', recipientCode: 'UF1234' }), {
        tenantId: t.tenantId, sellerId: t.sellerId, channel: new MockChannel(),
      });
    await f.deliver(QUEUES.submit, {
      tenantId: t.tenantId, attempt: 0, payload: { submissionId: s.submissionId },
    }).catch(() => undefined);
    expect(transmitted, 'an unsigned B2G invoice never reaches the vendor').toBe(0);
    expect(f.published.filter((p) => p.exchange === EXCHANGES.retry),
      'a missing signature is not retried').toHaveLength(0);
    expect(await stateOf(s.submissionId)).toBe(STATE.failed);
  });

  /**
   * The stranding bug (found 2026-10-02): a retryable failure scheduled a
   * retry but left the row `transmitting`, and the retry claims only
   * `queued` — so every vendor outage or empty wallet stranded the invoice
   * forever. 14 such submissions sat in the dev database.
   */
  describe('retryable failures', () => {
    const adapterThatFails = (err: ChannelError, calls: { n: number }): SdiChannelAdapter => ({
      name: 'openapi',
      capabilities: { serverSideSigning: true, pushNotifications: true, maxMessageBytes: 1e9 },
      submit: async () => {
        calls.n++;
        if (calls.n === 1) throw err;
        return { channelRef: `ref-${calls.n}`, acceptedAt: new Date() };
      },
      willSign: () => true,
    });

    it('NOT SENT (out of credit): back to queued, and the retry actually transmits', async () => {
      const calls = { n: 0 };
      const f = fakeBroker();
      await startSubmitWorker(h.db, f.broker, h.keys, logger, async () => ({
        adapter: adapterThatFails(new ChannelError('out of credit', true, 'ERR_CHANNEL_CREDIT', 'not_sent'), calls),
        config: {} }));
      const s = await submitInvoice(h.db, h.keys, validInvoice(), {
        tenantId: t.tenantId, sellerId: t.sellerId, channel: new MockChannel(),
      });
      const first = { tenantId: t.tenantId, attempt: 0, payload: { submissionId: s.submissionId } };
      await f.deliver(QUEUES.submit, first);
      expect(await stateOf(s.submissionId), 'not stranded in transmitting').toBe(STATE.queued);

      const retry = f.published.find((m) => m.exchange === EXCHANGES.retry);
      expect(retry, 'a retry was scheduled').toBeTruthy();
      await f.deliver(QUEUES.submit, retry!.body as never);
      expect(await stateOf(s.submissionId)).toBe(STATE.transmitted);
      expect(calls.n).toBe(2);
    });

    it('UNKNOWN outcome (timeout): NOT resent — it may already be at the vendor', async () => {
      const calls = { n: 0 };
      const f = fakeBroker();
      await startSubmitWorker(h.db, f.broker, h.keys, logger, async () => ({
        adapter: adapterThatFails(new ChannelError('timed out', true, 'ERR_CHANNEL_TIMEOUT', 'unknown'), calls),
        config: {} }));
      const s = await submitInvoice(h.db, h.keys, validInvoice(), {
        tenantId: t.tenantId, sellerId: t.sellerId, channel: new MockChannel(),
      });
      await f.deliver(QUEUES.submit, { tenantId: t.tenantId, attempt: 0, payload: { submissionId: s.submissionId } });
      expect(await stateOf(s.submissionId)).toBe(STATE.transmitting);
      expect(f.published.filter((m) => m.exchange === EXCHANGES.retry), 'no automatic resend').toHaveLength(0);
      const a = await withTenant(h.db, t.tenantId, (tx) => tx.query(
        `SELECT 1 FROM audit_log WHERE resource_id = $1 AND action = 'submission.outcome_unknown'`, [s.submissionId]));
      expect(a.rowCount, 'the ambiguity is recorded for an operator').toBe(1);
    });

    it('a channel that cannot be resolved does not strand the invoice', async () => {
      const f = fakeBroker();
      await startSubmitWorker(h.db, f.broker, h.keys, logger, async () => {
        throw new Error('stored credentials could not be read');
      });
      const s = await submitInvoice(h.db, h.keys, validInvoice(), {
        tenantId: t.tenantId, sellerId: t.sellerId, channel: new MockChannel(),
      });
      await f.deliver(QUEUES.submit, { tenantId: t.tenantId, attempt: 0, payload: { submissionId: s.submissionId } });
      expect(await stateOf(s.submissionId)).toBe(STATE.queued);
    });

    it('a terminal failure emits submission.failed to the CRM', async () => {
      const failing: SdiChannelAdapter = {
        name: 'openapi',
        capabilities: { serverSideSigning: true, pushNotifications: true, maxMessageBytes: 1e9 },
        submit: async () => { throw new ChannelError('refused', false, 'ERR_CHANNEL_REJECTED'); },
        willSign: () => true,
      };
      const f = fakeBroker();
      await startSubmitWorker(h.db, f.broker, h.keys, logger, async () => ({ adapter: failing, config: {} }));
      const s = await submitInvoice(h.db, h.keys, validInvoice(), {
        tenantId: t.tenantId, sellerId: t.sellerId, channel: new MockChannel(),
      });
      await f.deliver(QUEUES.submit, { tenantId: t.tenantId, attempt: 0, payload: { submissionId: s.submissionId } });
      expect(await stateOf(s.submissionId)).toBe(STATE.failed);
      const ev = await withTenant(h.db, t.tenantId, (tx) => tx.query<{ exchange: string; payload: Record<string, unknown> }>(
        `SELECT exchange, payload FROM outbox WHERE payload->>'submissionId' = $1
            AND payload->>'eventType' = 'submission.failed'`, [s.submissionId]));
      expect(ev.rowCount).toBe(1);
      expect(ev.rows[0]!.exchange, 'routed through the exchange queues are bound to').toBe(EXCHANGES.invoices);
      expect((ev.rows[0]!.payload['error'] as { code: string }).code).toBe('ERR_CHANNEL_REJECTED');
    });
  });

  describe('manual retry', () => {
    it('a FAILED submission is reset to queued, so the worker actually runs it', async () => {
      const s = await submitInvoice(h.db, h.keys, validInvoice(), {
        tenantId: t.tenantId, sellerId: t.sellerId, channel: new MockChannel(),
      });
      await withTenant(h.db, t.tenantId, (tx) => tx.query(
        'UPDATE sdi_submissions SET state=$2 WHERE id=$1', [s.submissionId, STATE.failed]));
      await retrySubmission(h.db, t.tenantId, s.submissionId);
      expect(await stateOf(s.submissionId)).toBe(STATE.queued);
    });

    it('a TRANSMITTED submission is refused — the vendor already has it', async () => {
      const s = await submitInvoice(h.db, h.keys, validInvoice(), {
        tenantId: t.tenantId, sellerId: t.sellerId, channel: new MockChannel(),
      });
      await withTenant(h.db, t.tenantId, (tx) => tx.query(
        'UPDATE sdi_submissions SET state=$2 WHERE id=$1', [s.submissionId, STATE.transmitted]));
      await expect(retrySubmission(h.db, t.tenantId, s.submissionId)).rejects.toThrow(/terminal/i);
    });
  });

  it('does not resubmit a submission already past queued', async () => {
    const s = await submitInvoice(h.db, h.keys, validInvoice(), {
      tenantId: t.tenantId, sellerId: t.sellerId, channel: new MockChannel(),
    });
    await withTenant(h.db, t.tenantId, (tx) => tx.query(
      'UPDATE sdi_submissions SET state=$2 WHERE id=$1', [s.submissionId, STATE.delivered]));
    const f = fakeBroker();
    await startSubmitWorker(h.db, f.broker, h.keys, logger,
      (id) => channelForTenant(h.db, h.keys, id));
    await f.deliver(QUEUES.submit, {
      tenantId: t.tenantId, attempt: 0, payload: { submissionId: s.submissionId },
    });
    expect(await stateOf(s.submissionId)).toBe(STATE.delivered);   // untouched
  });
});

describe('webhook worker', () => {
  // The dispatcher filters by each webhook's event list, so a test must
  // register a hook subscribed to the event it publishes.
  const registerHook = async (url: string, events: string[]) => {
    const { encrypt } = await import('../../src/infra/crypto/keys.ts');
    const e = encrypt(h.keys, 'whsec_test', t.tenantId, 'webhook_secret');
    await withTenant(h.db, t.tenantId, (tx) => tx.query(
      `INSERT INTO webhooks (tenant_id,url,events,secret_encrypted,secret_key_version,secret_iv,secret_tag)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [t.tenantId, url, events, e.ciphertext, e.keyVersion, e.iv, e.tag]));
  };

  it('signs the payload and records a successful delivery', async () => {
    const seen: Array<{ sig: string | null; body: string }> = [];
    const sender = async (_u: URL, init: { headers: Record<string,string>; body: string }) => {
      seen.push({
        sig: init.headers['x-passo-signature'] ?? null,
        body: init.body,
      });
      return { status: 200 };
    };
    await registerHook('https://1.1.1.1/hook', ['invoice.delivered']);
    const f = fakeBroker();
    await startWebhookWorker(h.db, f.broker, h.keys, logger, true, sender);
    await f.deliver(QUEUES.webhook, {
      tenantId: t.tenantId, attempt: 0,
      payload: { submissionId: null, eventType: 'invoice.delivered', notificationType: 'RC' },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('an NS payload carries requiresNewSubmission — the most-missed contract detail', async () => {
    const bodies: string[] = [];
    const sender = async (_u: URL, init: { headers: Record<string, string>; body: string }) => {
      bodies.push(init.body); return { status: 200 };
    };
    await registerHook('https://1.1.1.1/ns', ['invoice.rejected']);
    const f = fakeBroker();
    await startWebhookWorker(h.db, f.broker, h.keys, logger, true, sender);
    await f.deliver(QUEUES.webhook, {
      tenantId: t.tenantId, attempt: 0,
      payload: { submissionId: null, eventType: 'invoice.rejected', notificationType: 'NS',
                 errors: [{ codice: '00100', descrizione: 'Certificato scaduto' }] },
    });
    const ns = JSON.parse(bodies.find((b) => b.includes('invoice.rejected'))!);
    expect(ns.data.requiresNewSubmission).toBe(true);
    expect(ns.data.retryable).toBe(false);
    expect(ns.data.errors).toHaveLength(1);
    // The code is ENRICHED: "00100" alone would send an integrator hunting an
    // Italian-language PDF, and NS is terminal so they must act on it.
    expect(ns.data.errors[0].code).toBe('00100');
    expect(ns.data.errors[0].description).toMatch(/Certificato di firma scaduto/);
    expect(ns.data.errors[0].remedy).toBe('signature');
    expect(ns.data.errors[0].guidance).toMatch(/cannot fix/i);
    // SdI's own words are preserved beside ours.
    expect(ns.data.errors[0].sdiDescription).toBe('Certificato scaduto');
  });

  it('an MC payload says legallyIssued — it is NOT a failure', async () => {
    const bodies: string[] = [];
    const sender = async (_u: URL, init: { headers: Record<string, string>; body: string }) => {
      bodies.push(init.body); return { status: 200 };
    };
    await registerHook('https://1.1.1.1/mc', ['invoice.exception']);
    const f = fakeBroker();
    await startWebhookWorker(h.db, f.broker, h.keys, logger, true, sender);
    await f.deliver(QUEUES.webhook, {
      tenantId: t.tenantId, attempt: 0,
      payload: { submissionId: null, eventType: 'invoice.exception', notificationType: 'MC' },
    });
    const mc = JSON.parse(bodies.find((b) => b.includes('invoice.exception'))!);
    expect(mc.data.legallyIssued).toBe(true);
    expect(mc.data.action).toBe('none_required');
  });
});

/**
 * Duplicate submission to the tax authority.
 *
 * The claim used to be read-then-act with no lock, and `transmitting` was an
 * accepted re-entry state — so two concurrent deliveries of the same message
 * both read `queued` and both called the channel. SdI rejects the second as
 * 00409 (duplicate), leaving two documents to explain and an invoice whose
 * status is ambiguous.
 */
describe('submission claim is exclusive', () => {
  const submitOne = () => submitInvoice(h.db, h.keys, validInvoice(), {
    tenantId: t.tenantId, sellerId: t.sellerId, channel: new MockChannel(),
  });

  it('TWO concurrent deliveries submit exactly ONCE', async () => {
    const s = await submitOne();
    let submissions = 0;
    const counting = {
      ...new MockChannel(),
      name: 'mock',
      capabilities: new MockChannel().capabilities,
      submit: async (...a: Parameters<MockChannel['submit']>) => {
        submissions++;
        // Hold briefly so both deliveries overlap in flight.
        await new Promise((r) => setTimeout(r, 60));
        return new MockChannel().submit(...a);
      },
    } as unknown as MockChannel;

    const f = fakeBroker();
    await startSubmitWorker(h.db, f.broker, h.keys, logger,
      async () => ({ adapter: counting, config: {} }));

    const msg = { tenantId: t.tenantId, attempt: 0,
                  payload: { submissionId: s.submissionId } };
    await Promise.all([f.deliver(QUEUES.submit, msg), f.deliver(QUEUES.submit, msg)]);

    // One call to the vendor, not two.
    expect(submissions).toBe(1);
  });

  it('a submission already past `queued` is not re-submitted', async () => {
    const s = await submitOne();
    await withTenant(h.db, t.tenantId, (tx) => tx.query(
      `UPDATE sdi_submissions SET state = 'delivered' WHERE id = $1`, [s.submissionId]));

    let submissions = 0;
    const counting = {
      ...new MockChannel(), name: 'mock', capabilities: new MockChannel().capabilities,
      submit: async (...a: Parameters<MockChannel['submit']>) => {
        submissions++; return new MockChannel().submit(...a);
      },
    } as unknown as MockChannel;

    const f = fakeBroker();
    await startSubmitWorker(h.db, f.broker, h.keys, logger,
      async () => ({ adapter: counting, config: {} }));
    await f.deliver(QUEUES.submit,
      { tenantId: t.tenantId, attempt: 0, payload: { submissionId: s.submissionId } });

    expect(submissions).toBe(0);
  });
});
