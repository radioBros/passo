import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { connectBroker, isDelayedAvailable, parseEnvelope } from '../../src/infra/queue/broker.ts';
import { EXCHANGES, QUEUES, backoffMs, RETRY, dlqName } from '../../src/infra/queue/topology.ts';
import { logger } from '../../src/shared/logger.ts';

const URL = process.env['TEST_RABBITMQ_URL'] ?? 'amqp://localhost:55672';
const broker = await connectBroker(URL, logger);
afterAll(async () => { await broker.close(); });

const waitFor = async (p: () => boolean, ms = 15_000) => {
  const t0 = Date.now();
  while (!p() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return p();
};

describe('RabbitMQ topology', () => {
  it('the delayed-message plugin is available (retry ladder depends on it)', () => {
    expect(isDelayedAvailable()).toBe(true);
  });

  it('round-trips a job', async () => {
    const got: unknown[] = [];
    await broker.consume(QUEUES.transform, async (m) => { got.push(m); });
    broker.publish(EXCHANGES.invoices, `t.${QUEUES.transform}`, {
      tenantId: 'x', attempt: 0, payload: { hello: 'world' },
    });
    expect(await waitFor(() => got.length > 0)).toBe(true);
  });

  it('delays a retry by the requested interval — not immediate redelivery', async () => {
    let at = 0;
    await broker.consume(QUEUES.sign, async () => { at = Date.now(); });
    const sent = Date.now();
    broker.publish(EXCHANGES.retry, `t.${QUEUES.sign}`, {
      tenantId: 'x', attempt: 1, payload: {},
    }, { delayMs: 1200 });
    expect(await waitFor(() => at > 0)).toBe(true);
    expect(at - sent).toBeGreaterThan(900);      // genuinely delayed
  });

  it('a failing job dead-letters instead of spinning forever', async () => {
    const seen: unknown[] = [];
    await broker.consume(QUEUES.notify, async () => { throw new Error('boom'); });
    // @ts-expect-error dlq names are plain strings, not QueueName
    await broker.consume(dlqName(QUEUES.notify), async (m) => { seen.push(m); });
    broker.publish(EXCHANGES.invoices, `t.${QUEUES.notify}`, {
      tenantId: 'x', attempt: 0, payload: { will: 'fail' },
    });
    expect(await waitFor(() => seen.length > 0)).toBe(true);
  });
});

describe('per-job-type retry policy — never uniform', () => {
  it('deterministic stages do not retry (a failure is a data defect)', () => {
    expect(RETRY[QUEUES.transform].maxAttempts).toBe(1);
    expect(RETRY[QUEUES.generate].maxAttempts).toBe(1);
  });
  it('SdI submission retries with a long ceiling', () => {
    expect(RETRY[QUEUES.submit].maxAttempts).toBe(5);
    expect(RETRY[QUEUES.submit].maxMs).toBe(300_000);
  });
  it('webhooks have the longest ladder, up to an hour', () => {
    expect(RETRY[QUEUES.webhook].maxAttempts).toBe(6);
    expect(RETRY[QUEUES.webhook].maxMs).toBe(3_600_000);
  });
  it('backoff grows and stays within the ceiling', () => {
    const a = backoffMs(QUEUES.submit, 1);
    const b = backoffMs(QUEUES.submit, 4);
    expect(b).toBeGreaterThan(a);
    expect(backoffMs(QUEUES.submit, 99)).toBeLessThanOrEqual(RETRY[QUEUES.submit].maxMs * 1.25);
  });
});

/**
 * DEP-003 — booting without the delayed-message plugin must REFUSE to start.
 *
 * A missing plugin turns every retry into immediate redelivery: a hot loop that
 * would submit duplicates to the tax authority. Degrading quietly is the one
 * outcome worse than not booting. The plugin cannot be uninstalled from a live
 * broker, so the failure is reproduced faithfully by pre-declaring the retry
 * exchange with a conflicting type — `assertExchange` then fails exactly as it
 * does when `x-delayed-message` is unknown.
 */
describe('boot assertion — missing delayed-message plugin', () => {
  const vhostUrl = `${URL.replace(/\/?$/, '')}/nodelay`;

  // Self-provision the vhost so the suite runs on a clean machine.
  beforeAll(async () => {
    const u = new globalThis.URL(URL);
    /**
     * The management port is NOT derivable from the AMQP port: the RabbitMQ
     * defaults are 5672/15672, which are not adjacent. The local compose file
     * happens to map an adjacent pair, so deriving it works here and silently
     * targets the wrong port anywhere else. Derive only from a known-adjacent
     * local mapping, and require the variable otherwise.
     */
    const amqpPort = Number(u.port || 5672);
    const mgmt = process.env['TEST_RABBITMQ_MGMT']
      ?? (amqpPort !== 5672 ? `http://${u.hostname}:${amqpPort + 1}` : 'http://localhost:15672');
    const auth = 'Basic ' + Buffer.from(
      `${decodeURIComponent(u.username || 'guest')}:${decodeURIComponent(u.password || 'guest')}`,
    ).toString('base64');
    await fetch(`${mgmt}/api/vhosts/nodelay`, { method: 'PUT', headers: { authorization: auth } });
    await fetch(`${mgmt}/api/permissions/nodelay/${encodeURIComponent(u.username || 'guest')}`, {
      method: 'PUT',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ configure: '.*', write: '.*', read: '.*' }),
    });
  });

  it('REFUSES to boot rather than silently losing the retry ladder', async () => {
    const amqp = (await import('amqplib')).default;
    const conn = await amqp.connect(vhostUrl);
    const ch = await conn.createChannel();
    // Occupy the retry exchange name with an incompatible type.
    await ch.assertExchange(EXCHANGES.retry, 'topic', { durable: true });
    await ch.close();
    await conn.close();

    delete process.env['PASSO_ALLOW_NO_DELAYED_EXCHANGE'];
    await expect(connectBroker(vhostUrl, logger)).rejects.toThrow(/PASSO_BOOT_REFUSED/);
  });

  it('names the plugin and the remediation in the failure', async () => {
    delete process.env['PASSO_ALLOW_NO_DELAYED_EXCHANGE'];
    await expect(connectBroker(vhostUrl, logger)).rejects.toThrow(
      /rabbitmq_delayed_message_exchange/,
    );
  });

  it('an explicit opt-out allows a degraded local boot', async () => {
    process.env['PASSO_ALLOW_NO_DELAYED_EXCHANGE'] = '1';
    const b = await connectBroker(vhostUrl, logger);
    expect(isDelayedAvailable()).toBe(false);
    await b.close();
    delete process.env['PASSO_ALLOW_NO_DELAYED_EXCHANGE'];
  });
});

/**
 * QUEUE-004 — the envelope contract, enforced at RUNTIME.
 *
 * `JSON.parse(...) as JobMessage` is a compile-time assertion that checks
 * nothing. `tenant_id` is the RLS context source, so an envelope without one
 * would reach `withTenant(db, undefined, ...)`, set no tenant context, and let
 * RLS return zero rows — the job then reports success having silently done
 * nothing. Dead-lettering loudly is the only safe outcome.
 */
describe('message envelope contract', () => {
  it('REFUSES to publish an envelope with no tenant_id', () => {
    expect(() => broker.publish(EXCHANGES.invoices, `t.${QUEUES.transform}`,
      { attempt: 0, payload: {} } as never)).toThrow(/no tenant_id/);
  });

  it('refuses an empty-string tenant_id — not just a missing one', () => {
    expect(() => broker.publish(EXCHANGES.invoices, `t.${QUEUES.transform}`,
      { tenantId: '', attempt: 0, payload: {} } as never)).toThrow(/no tenant_id/);
  });

  it('rejects a non-JSON body at consume', () => {
    expect(() => parseEnvelope('not json at all')).toThrow(/not valid JSON/);
  });

  it('rejects a JSON scalar that is not an object', () => {
    expect(() => parseEnvelope('"a string"')).toThrow(/not an object/);
  });

  it('names tenant_id as the RLS context source when it refuses', () => {
    expect(() => parseEnvelope(JSON.stringify({ attempt: 0 })))
      .toThrow(/RLS context source/);
  });

  it('requires a numeric attempt counter — the retry ladder depends on it', () => {
    expect(() => parseEnvelope(JSON.stringify({ tenantId: 't', payload: {} })))
      .toThrow(/attempt counter/);
  });

  it('PRESERVES unknown fields so a v1 consumer survives a v2 envelope', () => {
    const e = parseEnvelope(JSON.stringify({
      tenantId: 't', attempt: 0, payload: { a: 1 }, traceId: 'abc', schemaVersion: 2,
    }));
    expect((e as unknown as Record<string, unknown>)['traceId']).toBe('abc');
    expect((e as unknown as Record<string, unknown>)['schemaVersion']).toBe(2);
  });

  it('defaults a missing payload to an empty object rather than undefined', () => {
    expect(parseEnvelope(JSON.stringify({ tenantId: 't', attempt: 1 })).payload).toEqual({});
  });
});

/**
 * A close listener per publish must be REMOVED once the publish settles.
 *
 * `once` fires at most once, but an un-fired listener stays registered — so one
 * per publish accumulates until Node warns about a leak and the channel carries
 * thousands of dead handlers. Observed as `MaxListenersExceededWarning` during
 * a full test run, which is the polite version of a slow memory leak in the
 * relay that publishes every invoice.
 */
describe('publishConfirmed listener hygiene', () => {
  it('does not accumulate close listeners across many publishes', async () => {
    let warned = false;
    const onWarning = (w: Error) => { if (/MaxListeners/.test(w.message)) warned = true; };
    process.on('warning', onWarning);
    try {
      for (let i = 0; i < 60; i++) {
        await broker.publishConfirmed(EXCHANGES.invoices, `t.${QUEUES.transform}`,
          { tenantId: 'listener-test', attempt: 0, payload: { i } });
      }
      // Node warns at 11 listeners; 60 publishes would trip it comfortably.
      expect(warned, 'a listener is leaking on every publish').toBe(false);
    } finally {
      process.off('warning', onWarning);
    }
  });
});

/**
 * Unroutable publishes must FAIL, not vanish (found 2026-10-02).
 *
 * Every receipt webhook was enqueued to `passo.webhooks`, an exchange with no
 * bindings. Without `mandatory` the broker confirmed each one and dropped it,
 * the relay stamped it published, and no CRM ever received a receipt event —
 * 156 such events in the dev database, every one marked published.
 */
describe('routability', () => {
  it('a publish that matches NO binding resolves false', async () => {
    const ok = await broker.publishConfirmed(EXCHANGES.webhooks, `t.${QUEUES.webhook}`,
      { tenantId: 'routability-test', attempt: 0, payload: {} });
    expect(ok, 'an unroutable message was confirmed as if delivered').toBe(false);
  });

  it('a webhook event published the way ingestion does is ROUTED', async () => {
    const ok = await broker.publishConfirmed(EXCHANGES.invoices, `t.${QUEUES.webhook}`,
      { tenantId: 'routability-test', attempt: 0, payload: { probe: true } });
    expect(ok).toBe(true);
  });

  it('nothing in src/ enqueues to the binding-less webhooks exchange', async () => {
    const { execSync } = await import('node:child_process');
    const hits = execSync('grep -rn "enqueue(" src || true', { encoding: 'utf8' })
      .split('\n').filter((l) => /EXCHANGES\.webhooks/.test(l));
    expect(hits).toEqual([]);
  });
});
