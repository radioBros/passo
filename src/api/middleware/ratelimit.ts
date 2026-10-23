import type { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterMemory, type RateLimiterAbstract } from 'rate-limiter-flexible';
import type { Redis } from 'ioredis';
import { ApiError } from '../../shared/errors/catalog.ts';
import type { Logger } from 'pino';

/** Per-key sliding window, falling back to in-memory when Redis is absent. */
export function createRateLimiter(redis: Redis | null, points = 100, duration = 60): RateLimiterAbstract {
  return redis
    ? new RateLimiterRedis({ storeClient: redis, keyPrefix: 'rl', points, duration })
    : new RateLimiterMemory({ points, duration });
}

/**
 * A spent budget and a broken Redis both reject — but they are NOT the same
 * event. `rate-limiter-flexible` rejects with a `RateLimiterRes` (carrying
 * `msBeforeNext`) when the caller is genuinely over budget, and with an `Error`
 * when the store is unreachable. Collapsing both into a 429 would let a Redis
 * blip halt invoice submission for every tenant at once.
 */
const isBudgetExhausted = (e: unknown): e is { msBeforeNext: number } =>
  !(e instanceof Error) && typeof e === 'object' && e !== null && 'msBeforeNext' in e;

export function rateLimit(limiter: RateLimiterAbstract, log?: Logger) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const id = req.keyId ?? req.ip ?? 'anon';
    try {
      const r = await limiter.consume(id);
      res.setHeader('x-ratelimit-limit', String(r.remainingPoints + r.consumedPoints));
      res.setHeader('x-ratelimit-remaining', String(r.remainingPoints));
      res.setHeader('x-ratelimit-reset', String(Math.ceil(r.msBeforeNext / 1000)));
      next();
      return;
    } catch (e) {
      if (isBudgetExhausted(e)) {
        res.setHeader('retry-after', String(Math.ceil((e.msBeforeNext || 1000) / 1000)));
        next(new ApiError('ERR_RATE_LIMITED'));
        return;
      }
      // FAIL OPEN. Redis holds nothing whose loss may block an invoice.
      log?.warn({ err: e, keyId: id },
        'rate limiter store unavailable — FAILING OPEN, requests are temporarily unlimited');
      res.setHeader('x-ratelimit-bypassed', 'store-unavailable');
      next();
      return;
    }
  };
}
