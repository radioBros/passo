import { describe, it, expect, vi } from 'vitest';
import { createRateLimiter, rateLimit } from '../../src/api/middleware/ratelimit.ts';
import { ApiError } from '../../src/shared/errors/catalog.ts';
import type { Request, Response, NextFunction } from 'express';

const mockReq = (keyId?: string) => ({ keyId, ip: '1.2.3.4' } as Request);
const mockRes = () => {
  const headers: Record<string, string> = {};
  return { setHeader: (k: string, v: string) => { headers[k] = v; }, headers } as unknown as
    Response & { headers: Record<string, string> };
};

describe('rate limiting', () => {
  it('falls back to in-memory when Redis is not configured', () => {
    expect(createRateLimiter(null, 5, 60)).toBeTruthy();
  });

  it('allows requests under the limit and reports what remains', async () => {
    const mw = rateLimit(createRateLimiter(null, 3, 60));
    const res = mockRes();
    const next = vi.fn();
    await mw(mockReq('k1'), res, next as unknown as NextFunction);
    expect(next).toHaveBeenCalledWith();
    expect(res.headers['x-ratelimit-remaining']).toBe('2');
  });

  it('rejects once the limit is exceeded and sets Retry-After', async () => {
    const limiter = createRateLimiter(null, 2, 60);
    const mw = rateLimit(limiter);
    const errs: unknown[] = [];
    const next = ((e?: unknown) => { if (e) errs.push(e); }) as NextFunction;
    const res = mockRes();
    for (let i = 0; i < 4; i++) await mw(mockReq('k2'), res, next);
    expect(errs.length).toBeGreaterThan(0);
    expect((errs[0] as ApiError).code).toBe('ERR_RATE_LIMITED');
    expect(res.headers['retry-after']).toBeTruthy();
  });

  it('meters per API key, not globally', async () => {
    const mw = rateLimit(createRateLimiter(null, 1, 60));
    const errs: unknown[] = [];
    const next = ((e?: unknown) => { if (e) errs.push(e); }) as NextFunction;
    await mw(mockReq('tenant-a'), mockRes(), next);
    await mw(mockReq('tenant-b'), mockRes(), next);
    expect(errs).toHaveLength(0);   // separate buckets
  });

  it('falls back to IP when there is no key (unauthenticated paths)', async () => {
    const mw = rateLimit(createRateLimiter(null, 1, 60));
    const errs: unknown[] = [];
    const next = ((e?: unknown) => { if (e) errs.push(e); }) as NextFunction;
    await mw(mockReq(undefined), mockRes(), next);
    await mw(mockReq(undefined), mockRes(), next);
    expect(errs).toHaveLength(1);
  });

  /**
   * A spent budget and an unreachable store are different events. Redis holds
   * nothing whose loss may block an invoice, so a store failure must let the
   * request through — collapsing both into a 429 would stop invoice submission
   * for every tenant the moment Redis blinks.
   */
  describe('store outage', () => {
    const brokenLimiter = () => ({
      consume: () => Promise.reject(new Error('ECONNREFUSED: redis is down')),
    } as unknown as Parameters<typeof rateLimit>[0]);

    it('FAILS OPEN when the store is unreachable — never blocks an invoice', async () => {
      const mw = rateLimit(brokenLimiter());
      const errs: unknown[] = [];
      const res = mockRes();
      const next = ((e?: unknown) => { if (e) errs.push(e); }) as NextFunction;
      await mw(mockReq('k'), res, next);
      expect(errs).toHaveLength(0);
      expect(res.headers['x-ratelimit-bypassed']).toBe('store-unavailable');
    });

    it('warns loudly when it bypasses, so an outage is never silent', async () => {
      const warn = vi.fn();
      const mw = rateLimit(brokenLimiter(), { warn } as never);
      await mw(mockReq('k'), mockRes(), (() => undefined) as NextFunction);
      expect(warn).toHaveBeenCalled();
    });

    it('still rejects a genuinely exhausted budget', async () => {
      const mw = rateLimit(createRateLimiter(null, 1, 60));
      const errs: unknown[] = [];
      const next = ((e?: unknown) => { if (e) errs.push(e); }) as NextFunction;
      await mw(mockReq('exhausted'), mockRes(), next);
      await mw(mockReq('exhausted'), mockRes(), next);
      expect((errs[0] as ApiError).code).toBe('ERR_RATE_LIMITED');
    });
  });
});
