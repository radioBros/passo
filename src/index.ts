#!/usr/bin/env node
import { loadConfig } from './shared/config.ts';
import { logger } from './shared/logger.ts';
import { createPool } from './infra/db/pool.ts';
import { EnvKeyProvider } from './infra/crypto/keys.ts';
import { connectBroker } from './infra/queue/broker.ts';
import { createServer } from './api/server.ts';
import { channelForTenant } from './infra/channels/registry.ts';
import { watchMilestone } from './infra/queue/milestone.ts';
import { resolveMcpKey } from './domain/apikey/mcp-keys.ts';
import { startRelay } from './infra/queue/outbox.ts';
import { startSubmitWorker } from './workers/submit.ts';
import { startWebhookWorker } from './workers/webhook.ts';
import { startPurgeScheduler } from './workers/purge.ts';
import { startMcpStdio } from './mcp/server.ts';
import { startPecPoller } from './workers/pec-poller.ts';
import { startVendorPoller } from './workers/vendor-poller.ts';
import { configureAlerts, startAlertDispatcher } from './domain/alert/service.ts';
import { startStallDetector } from './workers/stall-detector.ts';
import { startChainVerifier } from './workers/chain-verifier.ts';
import { Redis } from 'ioredis';

/**
 * Entry point. PASSO runs as three roles from one image:
 *   api    HTTP ingress
 *   worker queue consumers
 *   relay  outbox -> RabbitMQ
 * They have different scaling and failure characteristics, so they are separate
 * processes: a slow SdI submission must never affect HTTP responsiveness.
 */
const ROLE = process.argv[2] ?? process.env['PASSO_ROLE'] ?? 'api';
const VALID_ROLES = ['api', 'worker', 'relay', 'mcp'] as const;
if (!VALID_ROLES.includes(ROLE as never)) {
  console.error(`unknown role "${ROLE}" — expected one of: ${VALID_ROLES.join(', ')}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const cfg = loadConfig();          // fails fast, before any connection
  const keys = new EnvKeyProvider(); // refuses to start without an active key
  const db = createPool(cfg);
  const redis = cfg.REDIS_URL ? new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 2 }) : null;
  const shutdown: Array<() => Promise<void> | void> = [];
  // Every role can RAISE alerts (the relay abandons rows, the API resolves
  // channels); only the worker DISPATCHES them.
  const alertDeps = { db, cfg, log: logger, keys };
  configureAlerts(alertDeps);

  if (ROLE === 'api') {
    const broker = await connectBroker(cfg.RABBITMQ_URL, logger);
    const app = createServer({
      db, keys, cfg, redis,
      channelFor: (t) => channelForTenant(db, keys, t),
      // Sync mode: hold the connection until the invoice reaches SdI. Absent
      // Redis simply means every sync request falls back to 202.
      ...(redis ? { watchMilestone: (id: string) => watchMilestone(redis, id, logger) } : {}),
      ready: async () => {
        const checks = { postgres: false, rabbitmq: true, redis: true };
        try { await db.query('SELECT 1'); checks.postgres = true; } catch { /* down */ }
        if (redis) { try { await redis.ping(); } catch { checks.redis = false; } }
        // Deliberately NOT checking SdI vendors: an outage there must not take
        // PASSO out of rotation.
        return { ok: Object.values(checks).every(Boolean), checks };
      },
    }, cfg);
    const server = app.listen(cfg.PORT, () => logger.info({ port: cfg.PORT }, 'api listening'));
    shutdown.push(() => new Promise<void>((r) => server.close(() => r())));
    shutdown.push(() => broker.close());
  }

  if (ROLE === 'worker') {
    const broker = await connectBroker(cfg.RABBITMQ_URL, logger);
    await startSubmitWorker(db, broker, keys, logger, (t) => channelForTenant(db, keys, t), redis);
    await startWebhookWorker(db, broker, keys, logger, cfg.NODE_ENV !== 'production');
    const purge = startPurgeScheduler(db, cfg, logger);
    shutdown.push(() => { purge.stop(); });
    // PEC has no webhook: receipts arrive as email and must be polled.
    const pec = startPecPoller(db, keys, logger, cfg, cfg.PEC_POLL_INTERVAL_MS, redis);
    shutdown.push(() => { pec.stop(); });
    // API vendors push receipts; this re-reads them so a missed webhook is not
    // a lost receipt — and so a box with no public URL still receives them.
    const vendor = startVendorPoller(db, keys, logger, cfg.VENDOR_POLL_INTERVAL_MS, redis);
    shutdown.push(() => { vendor.stop(); });
    // Alerts are dispatched from Postgres, not RabbitMQ: "the broker is down"
    // must be able to alert too.
    const alerts = startAlertDispatcher(alertDeps);
    shutdown.push(() => { alerts.stop(); });
    // A submission awaiting a receipt raises no error on its own — without
    // this it waits forever, silently (NOTIF-023).
    const stalls = startStallDetector(db, logger);
    shutdown.push(() => { stalls.stop(); });
    // The hash chain makes tampering detectable; this is what detects it.
    const chains = startChainVerifier(db, logger);
    shutdown.push(() => { chains.stop(); });
    shutdown.push(() => broker.close());
    logger.info('worker started');
  }

  if (ROLE === 'mcp') {
    // MCP speaks JSON-RPC over stdio, so it runs as its own process rather than
    // alongside the API. The key is TENANT-SCOPED: an LLM sees exactly one
    // tenant, which is the property that makes exposing this safe at all.
    /**
     * A key resolves the tenant when one is supplied — that is a real,
     * revocable, per-assistant, audited credential. PASSO_MCP_TENANT_ID stays
     * as the self-hosted fallback where the operator starts the process
     * themselves and "can start the container" IS the authority.
     */
    const mcpKey = process.env['PASSO_MCP_KEY'];
    let tenantId = process.env['PASSO_MCP_TENANT_ID'];
    let keyScopes: string[] | undefined;
    if (mcpKey) {
      const resolved = await resolveMcpKey(db, mcpKey);
      tenantId = resolved.tenantId;
      keyScopes = resolved.scopes;
      logger.info({ tenantId, keyId: resolved.id, scopes: keyScopes },
        'MCP authenticated by key');
    }
    if (!tenantId) {
      logger.fatal('Set PASSO_MCP_KEY (preferred — revocable and audited) or PASSO_MCP_TENANT_ID. An MCP session is scoped to exactly one tenant.');
      process.exit(1);
    }
    await startMcpStdio({ db, tenantId, log: logger, ...(keyScopes ? { scopes: keyScopes } : {}) });
    return;   // stdio transport owns the lifetime
  }

  if (ROLE === 'relay') {
    const broker = await connectBroker(cfg.RABBITMQ_URL, logger);
    const relay = startRelay(db, broker, logger);
    shutdown.push(() => { relay.stop(); });
    shutdown.push(() => broker.close());
    logger.info('outbox relay started');
  }

  // Graceful shutdown: stop accepting, finish in flight, then close.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      logger.info({ sig }, 'shutting down');
      void (async () => {
        for (const fn of shutdown) await fn();
        await db.end().catch(() => undefined);
        redis?.disconnect();
        process.exit(0);
      })();
    });
  }
}

main().catch((e) => {
  logger.fatal({ err: e }, 'failed to start');
  process.exit(1);
});
