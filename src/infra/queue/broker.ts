import amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import { EXCHANGES, QUEUES, dlqName, type QueueName } from './topology.ts';
import type { Logger } from '../../shared/logger.ts';

export interface Broker {
  publish(exchange: string, routingKey: string, body: unknown, opts?: { delayMs?: number }): boolean;
  /**
   * Publish and WAIT for the broker to confirm (QUEUE-006).
   *
   * `publish` returns amqplib's local buffer status — whether the bytes fit in
   * the socket buffer — NOT whether RabbitMQ accepted them. Marking an outbox
   * row published on that basis loses the message if the broker dies in the
   * window, which is precisely the loss the outbox exists to prevent.
   *
   * Resolves true only on a broker ack. Any nack, channel close or timeout
   * resolves false, leaving the row claimable by the next relay pass.
   */
  publishConfirmed(
    exchange: string, routingKey: string, body: unknown, opts?: { delayMs?: number },
  ): Promise<boolean>;
  consume(q: QueueName, handler: (msg: JobMessage) => Promise<void>, prefetch?: number): Promise<void>;
  close(): Promise<void>;
}

export interface JobMessage {
  tenantId: string;
  submissionId?: string;
  attempt: number;
  payload: Record<string, unknown>;
}

/**
 * Validate an envelope at the boundary (QUEUE-004).
 *
 * `JSON.parse(...) as JobMessage` is a compile-time assertion that checks
 * nothing at runtime. Without this, an envelope missing `tenantId` reaches
 * `withTenant(db, undefined, ...)`, where the tenant context is set to nothing
 * and RLS quietly returns zero rows — the job then "succeeds" having done
 * nothing at all. `tenant_id` is the RLS context source, so a missing or
 * non-string one must dead-letter loudly instead.
 */
export class EnvelopeError extends Error {}

export function parseEnvelope(raw: string): JobMessage {
  let v: unknown;
  try { v = JSON.parse(raw); }
  catch { throw new EnvelopeError('envelope is not valid JSON'); }

  if (typeof v !== 'object' || v === null) {
    throw new EnvelopeError('envelope is not an object');
  }
  const e = v as Record<string, unknown>;
  if (typeof e['tenantId'] !== 'string' || e['tenantId'] === '') {
    throw new EnvelopeError(
      'envelope has no tenant_id — refusing to process: tenant_id is the RLS ' +
      'context source, and defaulting it would run the job against no tenant');
  }
  if (typeof e['attempt'] !== 'number') {
    throw new EnvelopeError('envelope has no numeric attempt counter');
  }
  // Forward-compatible: unknown fields are preserved so a v1 consumer can
  // handle a v2 envelope during a rolling deploy.
  return { ...e, tenantId: e['tenantId'], attempt: e['attempt'],
           payload: (e['payload'] ?? {}) as Record<string, unknown> };
}

/** True when the delayed-message plugin is available. */
let delayedAvailable = false;
export const isDelayedAvailable = (): boolean => delayedAvailable;

export async function connectBroker(url: string, log: Logger): Promise<Broker> {
  const conn = await amqp.connect(url);
  const ch = await conn.createConfirmChannel();

  /**
   * amqplib emits 'error' on the connection and channel. An EventEmitter with
   * no 'error' listener THROWS, taking the whole process down — so a single
   * bad publish (an unknown exchange, say) would kill the relay for every
   * tenant. These handlers turn that into a logged, recoverable event.
   */
  conn.on('error', (err: Error) => log.error({ err }, 'amqp connection error'));
  conn.on('close', () => log.warn('amqp connection closed'));
  ch.on('error', (err: Error) => log.error({ err }, 'amqp channel error'));
  ch.on('close', () => log.warn('amqp channel closed'));

  await ch.assertExchange(EXCHANGES.invoices, 'topic', { durable: true });
  await ch.assertExchange(EXCHANGES.dlx, 'topic', { durable: true });
  await ch.assertExchange(EXCHANGES.webhooks, 'topic', { durable: true });

  // The retry ladder depends on rabbitmq_delayed_message_exchange. If the
  // plugin is missing, an x-delayed-message exchange cannot be declared and
  // retries would silently become IMMEDIATE redelivery — a hot loop against
  // SdI. Detect it at boot and refuse to pretend.
  try {
    await ch.assertExchange(EXCHANGES.retry, 'x-delayed-message', {
      durable: true, arguments: { 'x-delayed-type': 'topic' },
    });
    delayedAvailable = true;
  } catch {
    delayedAvailable = false;
    const remediation =
      'rabbitmq_delayed_message_exchange plugin is NOT installed. Without it, every retry ' +
      'becomes IMMEDIATE redelivery — a hot loop that would hammer SdI with duplicate ' +
      'submissions. Build the broker from docker/rabbitmq/Dockerfile, which bakes the plugin in. ' +
      'To run degraded anyway (local development only), set PASSO_ALLOW_NO_DELAYED_EXCHANGE=1.';

    if (process.env['PASSO_ALLOW_NO_DELAYED_EXCHANGE'] !== '1') {
      log.error({ exchange: EXCHANGES.retry }, remediation);
      await conn.close().catch(() => undefined);
      throw new Error(`PASSO_BOOT_REFUSED: ${remediation}`);
    }

    log.warn(
      { exchange: EXCHANGES.retry },
      `${remediation} — PROCEEDING DEGRADED because PASSO_ALLOW_NO_DELAYED_EXCHANGE=1.`,
    );
    // Reconnect: a failed assert closes the channel.
    return connectBrokerWithoutDelay(conn, log);
  }

  for (const q of Object.values(QUEUES)) {
    await ch.assertQueue(dlqName(q), { durable: true });
    await ch.assertQueue(q, {
      durable: true,
      deadLetterExchange: EXCHANGES.dlx,
      deadLetterRoutingKey: dlqName(q),
    });
    await ch.bindQueue(q, EXCHANGES.invoices, `*.${q}`);
    await ch.bindQueue(q, EXCHANGES.retry, `*.${q}`);
    await ch.bindQueue(dlqName(q), EXCHANGES.dlx, dlqName(q));
  }

  return makeBroker(conn, ch, log);
}

async function connectBrokerWithoutDelay(
  conn: amqp.ChannelModel, log: Logger,
): Promise<Broker> {
  const ch = await conn.createConfirmChannel();
  await ch.assertExchange(EXCHANGES.invoices, 'topic', { durable: true });
  await ch.assertExchange(EXCHANGES.dlx, 'topic', { durable: true });
  await ch.assertExchange(EXCHANGES.webhooks, 'topic', { durable: true });
  for (const q of Object.values(QUEUES)) {
    await ch.assertQueue(dlqName(q), { durable: true });
    await ch.assertQueue(q, {
      durable: true, deadLetterExchange: EXCHANGES.dlx, deadLetterRoutingKey: dlqName(q),
    });
    await ch.bindQueue(q, EXCHANGES.invoices, `*.${q}`);
    await ch.bindQueue(dlqName(q), EXCHANGES.dlx, dlqName(q));
  }
  return makeBroker(conn, ch, log);
}

function makeBroker(conn: amqp.ChannelModel, ch: amqp.ConfirmChannel, log: Logger): Broker {
  /**
   * The publishing channel, which is REPLACED when the broker closes it.
   *
   * RabbitMQ closes the whole channel on a per-message error — publishing to an
   * unknown exchange, for instance. Every later publish on that channel then
   * fails with "Channel closed", so a single malformed row silently takes down
   * publication for every tenant: valid invoices burn through their retries and
   * are abandoned, turning one bad message into mass loss.
   *
   * Re-opening on demand contains the damage to the message that caused it.
   */
  let pub: amqp.ConfirmChannel = ch;
  let pubUsable = true;
  let reopening: Promise<amqp.ConfirmChannel> | null = null;

  const attach = (c: amqp.ConfirmChannel): amqp.ConfirmChannel => {
    c.on('error', (err: Error) => log.error({ err }, 'amqp publish channel error'));
    // The flag is what makes the NEXT publish re-open. Probing amqplib's
    // internals instead is unreliable — the teardown is not synchronous with
    // the close event, so a publish in the same tick still sees a live channel.
    c.on('close', () => {
      pubUsable = false;
      log.warn('amqp publish channel closed — re-opening on the next publish');
    });
    return c;
  };
  attach(pub);

  /** One re-open at a time, however many publishes are waiting on it. */
  const publishChannel = async (): Promise<amqp.ConfirmChannel> => {
    if (pubUsable) return pub;
    reopening ??= conn.createConfirmChannel()
      .then((c) => { pub = attach(c); pubUsable = true; reopening = null; return pub; })
      .catch((err: unknown) => { reopening = null; throw err; });
    return reopening;
  };

  return {
    publish(exchange, routingKey, body, opts) {
      // Reject at publish too: a bad envelope should fail where it is created,
      // with a stack pointing at the producer, not later in a worker.
      if (typeof (body as JobMessage).tenantId !== 'string' || !(body as JobMessage).tenantId) {
        throw new EnvelopeError(`refusing to publish an envelope with no tenant_id to ${routingKey}`);
      }
      const headers = opts?.delayMs && delayedAvailable
        ? { 'x-delay': opts.delayMs }
        : undefined;
      /**
       * `pub`, not the captured `ch`.
       *
       * A per-message error closes the whole channel, and every later publish
       * on it throws `IllegalOperationError: Channel closed`. This is the RETRY
       * path, so the throw escapes the worker's own catch block and the
       * submission strands in `transmitting` forever — no `failed` state, no
       * milestone, no operator signal. `pub` is replaced when the broker closes
       * it; `ch` never is.
       */
      return pub.publish(
        exchange, routingKey, Buffer.from(JSON.stringify(body)),
        { persistent: true, contentType: 'application/json', ...(headers ? { headers } : {}) },
      );
    },
    async publishConfirmed(exchange, routingKey, body, opts) {
      if (typeof (body as JobMessage).tenantId !== 'string' || !(body as JobMessage).tenantId) {
        throw new EnvelopeError(`refusing to publish an envelope with no tenant_id to ${routingKey}`);
      }
      const headers = opts?.delayMs && delayedAvailable
        ? { 'x-delay': opts.delayMs }
        : undefined;

      let c: amqp.ConfirmChannel;
      try {
        c = await publishChannel();
      } catch (e) {
        log.error({ err: e, exchange, routingKey }, 'could not open a publish channel');
        return false;
      }

      return new Promise<boolean>((resolve) => {
        /**
         * A channel error between publish and confirm would leave this promise
         * pending forever, stalling the relay loop — hence the close listener.
         *
         * It MUST be removed once settled: `once` only fires once, but an
         * un-fired listener stays registered, so one per publish accumulates
         * until Node warns about a leak and the channel carries thousands of
         * dead handlers.
         */
        let settled = false;
        /**
         * `mandatory`: an UNROUTABLE message is returned, not confirmed.
         *
         * Without it the broker confirms a message that matches no binding and
         * silently drops it. That is exactly how every receipt webhook was
         * lost: they were published to an exchange with no bindings, confirmed,
         * marked `published_at` by the relay — and never delivered. With
         * `mandatory`, RabbitMQ sends basic.return BEFORE the ack, so a returned
         * message resolves `false` and the outbox row is retried and, if it can
         * never be routed, abandoned visibly.
         *
         * Not for the delayed exchange: the delayed-message plugin cannot route
         * at publish time and does not support `mandatory`.
         */
        const mandatory = exchange !== EXCHANGES.retry && !opts?.delayMs;
        const messageId = randomUUID();
        let returned = false;
        const onReturn = (m: amqp.Message) => {
          if (m.properties.messageId !== messageId) return;
          returned = true;
          log.error({ exchange, routingKey }, 'UNROUTABLE publish — no queue is bound for this routing key');
        };
        const onClose = () => done(false);
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          c.removeListener('close', onClose);
          c.removeListener('return', onReturn);
          resolve(ok);
        };
        c.once('close', onClose);
        if (mandatory) c.on('return', onReturn);
        try {
          c.publish(
            exchange, routingKey, Buffer.from(JSON.stringify(body)),
            { persistent: true, contentType: 'application/json', messageId, mandatory,
              ...(headers ? { headers } : {}) },
            (err) => done(!err && !returned),
          );
        } catch (e) {
          log.error({ err: e, exchange, routingKey }, 'confirmed publish threw');
          done(false);
        }
      });
    },
    async consume(q, handler, prefetch = 4) {
      await ch.prefetch(prefetch);
      await ch.consume(q, (msg) => {
        if (!msg) return;
        void (async () => {
          try {
            await handler(parseEnvelope(msg.content.toString('utf8')));
            ch.ack(msg);
          } catch (e) {
            log.error({ err: e, queue: q }, 'job failed');
            // requeue=false: routing to the DLX is what gives us a dead-letter
            // queue at all. Requeueing here would spin the message forever.
            ch.nack(msg, false, false);
          }
        })();
      });
    },
    async close() { await ch.close().catch(() => undefined); await conn.close().catch(() => undefined); },
  };
}
