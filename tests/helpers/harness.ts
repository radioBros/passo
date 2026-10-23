import { createPool, withTx, type Db } from '../../src/infra/db/pool.ts';
import { EnvKeyProvider, type KeyProvider } from '../../src/infra/crypto/keys.ts';
import { createServer } from '../../src/api/server.ts';
import { loadConfig, type Config } from '../../src/shared/config.ts';
import { channelForTenant } from '../../src/infra/channels/registry.ts';
import { createApiKey } from '../../src/domain/apikey/service.ts';
import { encrypt } from '../../src/infra/crypto/keys.ts';
import { withTenant } from '../../src/infra/db/pool.ts';
import type { Express } from 'express';

/**
 * Shared API test harness.
 *
 * Runs the real Express app against the real database and broker — no route
 * stubs. A test that passes here exercised the same middleware chain, RLS
 * context and error handler as production.
 */
export const ADMIN_KEY = process.env['TEST_ADMIN_KEY'] ?? 'test-admin-key-at-least-24-chars-long';
const ENC_KEY = Buffer.alloc(32, 9).toString('base64');

export function testConfig(over: Partial<Record<string, string>> = {}): Config {
  return loadConfig({
    DATABASE_URL: process.env['TEST_DATABASE_URL']
      ?? 'postgres://passo_app:apppass@localhost:55432/passo',
    RABBITMQ_URL: process.env['TEST_RABBITMQ_URL'] ?? 'amqp://localhost:55672',
    REDIS_URL: process.env['TEST_REDIS_URL'] ?? 'redis://localhost:56379',
    PASSO_ADMIN_KEY: ADMIN_KEY,
    PASSO_ENCRYPTION_KEY_ACTIVE: 'v1',
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    // A suite makes far more requests per tenant than a real CRM would in a
    // minute. At the production default of 100/min a long suite trips its own
    // limiter and fails with 429 where it asserted 400 — a flake that looks
    // like a logic bug. Rate limiting itself is covered by ratelimit.test.ts,
    // which sets its own budgets explicitly.
    RATE_LIMIT_POINTS: '100000',
    // Vitest runs test FILES in parallel and several suites build more than one
    // harness, so the production pool size (10) multiplies past Postgres's
    // max_connections and later suites fail to connect. A test harness needs
    // very few connections; connection-pool behaviour itself is not what these
    // suites are testing.
    DATABASE_POOL_MAX: '4',
    ...over,
  } as NodeJS.ProcessEnv);
}

export const testKeys = (): KeyProvider => new EnvKeyProvider({
  PASSO_ENCRYPTION_KEY_V1: ENC_KEY,
  PASSO_ENCRYPTION_KEY_ACTIVE: 'v1',
});

export interface Harness {
  app: Express; db: Db; keys: KeyProvider; cfg: Config;
  close: () => Promise<void>;
}

export function createHarness(over: Partial<Record<string, string>> = {}): Harness {
  const cfg = testConfig(over);
  const db = createPool(cfg);
  const keys = testKeys();
  const app = createServer({
    db, keys, cfg, redis: null,
    channelFor: (t) => channelForTenant(db, keys, t),
    ready: async () => {
      const checks = { postgres: false, rabbitmq: true, redis: true };
      try { await db.query('SELECT 1'); checks.postgres = true; } catch { /* down */ }
      return { ok: checks.postgres, checks };
    },
  }, cfg);
  return { app, db, keys, cfg, close: async () => { await db.end(); } };
}

/** A fully provisioned tenant: seller, mock channel, live API key. */
export async function seedTenant(h: Harness, slug = `t-${Math.random().toString(36).slice(2, 8)}`) {
  const t = await withTx(h.db, (tx) => tx.query<{ id: string }>(
    `INSERT INTO tenants (name, slug, transmitter_country, transmitter_code)
     VALUES ($1,$2,'IT',$3) RETURNING id`,
    [slug, slug, String(Math.floor(Math.random() * 9e10) + 1e10)],
  ));
  const tenantId = t.rows[0]!.id;

  const s = await withTenant(h.db, tenantId, (tx) => tx.query<{ id: string }>(
    `INSERT INTO sellers (tenant_id, tax_regime, denomination, vat_country, vat_code, address)
     VALUES ($1,'RF01','Fornitore S.r.l.','IT','01234567890',$2) RETURNING id`,
    [tenantId, JSON.stringify({
      street: 'Via Roma', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT',
    })],
  ));

  const enc = encrypt(h.keys, JSON.stringify({}), tenantId, 'channel_config');
  await withTenant(h.db, tenantId, (tx) => tx.query(
    `INSERT INTO channel_credentials
       (tenant_id, channel, config_encrypted, config_key_version, config_iv, config_tag)
     VALUES ($1,'mock',$2,$3,$4,$5)
     ON CONFLICT (tenant_id, channel) DO UPDATE SET active = true`,
    [tenantId, enc.ciphertext, enc.keyVersion, enc.iv, enc.tag],
  ));

  const key = await createApiKey(h.db, tenantId, 'test');
  return { tenantId, sellerId: s.rows[0]!.id, apiKey: key.key, keyId: key.id };
}

/** A schema-valid B2B invoice; override any field to test a specific rule. */
export const validInvoice = (over: Record<string, unknown> = {}) => ({
  documentType: 'TD01',
  number: `T-${Math.random().toString(36).slice(2, 8)}`,
  date: '2026-09-01',
  currency: 'EUR',
  format: 'FPR12',
  recipientCode: 'ABC1234',
  seller: {
    vatId: { country: 'IT', code: '01234567890' },
    name: 'Fornitore S.r.l.', taxRegime: 'RF01',
    address: { street: 'Via Roma', postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' },
  },
  buyer: {
    vatId: { country: 'IT', code: '09876543210' }, name: 'Cliente S.p.A.',
    address: { street: 'Via Milano', postalCode: '00100', city: 'Roma', province: 'RM', country: 'IT' },
  },
  lines: [{
    lineNumber: 1, description: 'Consulenza', quantity: '10.00', unitOfMeasure: 'ora',
    unitPrice: '100.00', totalPrice: '1000.00', vatRate: '22.00',
  }],
  summaries: [{
    vatRate: '22.00', taxableAmount: '1000.00', taxAmount: '220.00', vatCollectability: 'I',
  }],
  ...over,
});
