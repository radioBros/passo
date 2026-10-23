import express, { type Express } from 'express';
import type { Config } from '../shared/config.ts';
import { requestId, errorHandler, notFound } from './middleware/errors.ts';
import { tenantAuth, adminAuth } from './middleware/auth.ts';
import { rateLimit, createRateLimiter } from './middleware/ratelimit.ts';
import { UsageMeter, meter } from './middleware/metering.ts';
import { invoiceRoutes, type Deps } from './routes/invoices.ts';
import { adminRoutes } from './routes/admin.ts';
import { webhookRoutes } from './routes/webhooks.ts';
import { inboundRoutes } from './routes/inbound.ts';
import { privacyRoutes } from './routes/privacy.ts';
import type { Redis } from 'ioredis';
import helmet from 'helmet';
import cors from 'cors';
import { logger } from '../shared/logger.ts';
import { corsOrigins } from '../shared/config.ts';

export interface ServerDeps extends Deps {
  redis: Redis | null;
  ready: () => Promise<{ ok: boolean; checks: Record<string, boolean> }>;
}

export function createServer(d: ServerDeps, cfg: Config): Express {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');   // ETags on invoice reads leak nothing useful and cache poorly.

  /**
   * PASSO is a JSON/XML API, never a browser document surface — so the CSP is
   * maximally restrictive and the frame/embed vectors are closed outright.
   * HSTS is emitted only when an operator has set a max-age (0 in plain-HTTP
   * local development, where the header would pin the browser to a scheme the
   * dev stack does not serve).
   */
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"], 'frame-ancestors': ["'none'"], 'base-uri': ["'none'"],
        'form-action': ["'none'"], 'sandbox': [],
      },
    },
    hsts: cfg.PASSO_HSTS_MAX_AGE > 0
      ? { maxAge: cfg.PASSO_HSTS_MAX_AGE, includeSubDomains: true, preload: false }
      : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    xFrameOptions: { action: 'deny' },
  }));

  const origins = corsOrigins(cfg);
  if (origins.length > 0) {
    app.use(cors({
      origin: origins.includes('*') ? '*' : origins,
      credentials: cfg.PASSO_CORS_CREDENTIALS === 'true',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type', 'idempotency-key'],
      exposedHeaders: ['x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'retry-after'],
      maxAge: 600,
    }));
  }

  app.use(requestId);
  app.use('/api/v1/render', express.text({ type: ['application/xml', 'text/xml'], limit: '10mb' }));
  /**
   * JSON everywhere EXCEPT the inbound vendor webhook. That route caps its body
   * at 2MB and parses only AFTER the per-tenant token is verified; a global
   * JSON parser ran first, so an unauthenticated caller could make PASSO parse
   * 10MB of JSON, and the route then saw an empty body — which is why every
   * OpenAPI.it (JSON) callback was refused.
   */
  const json = express.json({ limit: '10mb' });
  app.use((req, res, next) => (req.path.startsWith('/api/v1/inbound/') ? next() : json(req, res, next)));

  // Liveness: process only. NOTHING external — not even the database.
  app.get('/health/live', (_req, res) => { res.json({ status: 'ok' }); });

  // Readiness: our own dependencies. Deliberately EXCLUDES SdI vendors — a
  // vendor outage must not take PASSO out of rotation, because Postgres is the
  // durability boundary and invoices accepted during an outage submit later.
  app.get('/health/ready', (_req, res) => {
    void d.ready().then((r) => res.status(r.ok ? 200 : 503).json(r));
  });

  const limiter = createRateLimiter(d.redis, cfg.RATE_LIMIT_POINTS, cfg.RATE_LIMIT_DURATION_SEC);
  /**
   * Inbound vendor webhooks authenticate by their own per-tenant token, so they
   * are mounted BEFORE tenantAuth — a vendor holds no API key. They are rate
   * limited independently: this endpoint is public, and sharing a budget with
   * the tenant API would let a flood of forged callbacks starve real traffic.
   */
  app.use('/api/v1', rateLimit(createRateLimiter(d.redis, 600, 60), logger), inboundRoutes(d));

  app.use('/api/v1/admin', adminAuth(cfg.PASSO_ADMIN_KEY), adminRoutes(d));
  // Metering sits AFTER auth (it needs the tenant) and after rate limiting (a
  // 429 is worth measuring — it is how an operator sees a starving caller).
  const usage = new UsageMeter(d.db, logger);
  app.use('/api/v1', tenantAuth(d.db), rateLimit(limiter, logger), meter(usage),
          invoiceRoutes(d), webhookRoutes(d), privacyRoutes(d));
  (app as unknown as { usageMeter: UsageMeter }).usageMeter = usage;

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
