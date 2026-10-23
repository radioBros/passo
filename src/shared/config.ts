import { z } from 'zod';

/**
 * Boot-time configuration. Validated BEFORE any connection is opened, so a
 * missing secret fails loudly at startup rather than on the first invoice.
 * Every problem is reported at once, not one per restart.
 */
const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PASSO_BASE_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  RABBITMQ_URL: z.string().min(1).default('amqp://localhost'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  PASSO_ADMIN_KEY: z.string().min(24),

  PASSO_ENCRYPTION_KEY_ACTIVE: z.string().min(1),

  PASSO_XSD_DIR: z.string().default('assets/xsd'),
  PASSO_XSL_DIR: z.string().default('assets/xsl'),
  PASSO_RENDER_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(10_000),
  PASSO_MAX_RENDER_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),
  PEC_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
  // API vendors push receipts, but a missed webhook is a lost receipt; this is
  // the fallback that re-reads them. Each tick costs one request per pending invoice.
  VENDOR_POLL_INTERVAL_MS: z.coerce.number().int().min(30_000).default(300_000),

  SYNC_MAX_WAIT_MS: z.coerce.number().int().positive().max(120_000).default(120_000),
  CORRELATION_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  AUDIT_RETENTION_MONTHS: z.coerce.number().int().positive().default(12),
  RECEIPT_ACK_GRACE_DAYS: z.coerce.number().int().positive().default(7),

  /**
   * Operational tables (outbox, webhook delivery log, resolved quarantine).
   * These carry no fiscal record — only the trace of work already finished —
   * but they are the fastest-growing tables in the system, so they need a
   * bound. Only FINISHED rows are ever eligible.
   */
  OPERATIONAL_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  /** Must exceed any client's retry budget, or a retry could double-submit. */
  IDEMPOTENCY_RETENTION_DAYS: z.coerce.number().int().positive().default(7),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * CORS is OFF by default: PASSO is a server-to-server relay, and a browser
   * origin has no business holding a CRM's API key. An operator opts in with an
   * explicit comma-separated allowlist.
   */
  PASSO_CORS_ORIGINS: z.string().default(''),
  PASSO_CORS_CREDENTIALS: z.enum(['true', 'false']).default('false'),

  /** HSTS max-age in seconds; 0 disables the header (plain-HTTP local dev). */
  PASSO_HSTS_MAX_AGE: z.coerce.number().int().min(0).default(31_536_000),

  /** Per-tenant request budget: POINTS requests per DURATION seconds. */
  RATE_LIMIT_POINTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_DURATION_SEC: z.coerce.number().int().positive().default(60),

  /**
   * ALERTS — all optional. Problems that stop invoices (a vendor wallet out of
   * credit, a seller not registered, a PEC mailbox password changed) are sent
   * by email and/or webhook. With none of this set, alerts are still recorded
   * and listed by `GET /api/v1/admin/alerts`; they are just not pushed.
   *
   * The SMTP server is a NORMAL outbox (not PEC), shared by the instance.
   * TLS is always required: port 465 uses implicit TLS, anything else STARTTLS.
   */
  ALERT_SMTP_HOST: z.string().default(''),
  ALERT_SMTP_PORT: z.coerce.number().int().positive().default(587),
  ALERT_SMTP_USER: z.string().default(''),
  ALERT_SMTP_PASSWORD: z.string().default(''),
  ALERT_FROM: z.string().default(''),
  /** Comma-separated; receives EVERY alert from every tenant, plus system ones. */
  OPERATOR_ALERT_EMAIL: z.string().default(''),
  OPERATOR_ALERT_WEBHOOK_URL: z.string().default(''),
  /** Signs operator alert webhooks (x-passo-signature), like CRM webhooks. */
  OPERATOR_ALERT_WEBHOOK_SECRET: z.string().default(''),
  /** While a problem persists, notify again this often (its occurrences are counted meanwhile). */
  ALERT_REPEAT_MINUTES: z.coerce.number().int().min(5).default(360),
  ALERT_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = Schema.safeParse(env);
  if (!r.success) {
    const problems = r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    // Never echo the values — only which variables are wrong.
    throw new Error(`Invalid configuration:\n${problems}`);
  }

  // `Access-Control-Allow-Origin: *` with credentials is refused by every
  // browser, but an operator who sets it believes cross-origin auth works.
  // Fail at boot rather than at the first browser request.
  const origins = r.data.PASSO_CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  if (origins.includes('*') && r.data.PASSO_CORS_CREDENTIALS === 'true') {
    throw new Error(
      'Invalid configuration:\n  PASSO_CORS_ORIGINS: wildcard "*" cannot be combined with ' +
      'PASSO_CORS_CREDENTIALS=true — browsers reject that pair. List explicit origins instead.',
    );
  }

  return r.data;
}

/** Parsed CORS allowlist. Empty means: emit no CORS headers at all. */
export const corsOrigins = (cfg: Config): string[] =>
  cfg.PASSO_CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
