import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { ERRORS, ApiError } from '../../src/shared/errors/catalog.ts';

/**
 * The error catalogue (API-003 / API-024).
 *
 * Two failure modes, both of which produce a bad integration experience:
 *
 *   - A code in the catalogue that nothing ever throws is a PROMISE the code
 *     does not keep. An integrator writes a handler for it and waits forever.
 *   - A code thrown but never asserted is one nobody has checked actually
 *     reaches the caller with the right status and retryability.
 */
const srcFiles: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(`${d}/${e.name}`);
    else if (e.name.endsWith('.ts')) srcFiles.push(`${d}/${e.name}`);
  }
};
walk('src');
const allSrc = srcFiles
  .filter((f) => !f.endsWith('catalog.ts'))
  .map((f) => readFileSync(f, 'utf8')).join('\n');

describe('error catalogue', () => {
  it('every code has a status, a message and an explicit retryability', () => {
    for (const [code, def] of Object.entries(ERRORS)) {
      expect(def.http, code).toBeGreaterThanOrEqual(400);
      expect(def.message.length, code).toBeGreaterThan(8);
      expect(typeof def.retryable, code).toBe('boolean');
    }
  });

  it('EVERY code is reachable — none is a promise the code does not keep', () => {
    const unreachable = Object.keys(ERRORS).filter((c) => !allSrc.includes(c));
    expect(unreachable,
      'these codes exist in the catalogue but nothing throws them').toEqual([]);
  });

  /**
   * Retryability is the field a CRM automates on. A retryable code for a
   * deterministic failure produces an infinite retry loop; a non-retryable code
   * for a transient one loses an invoice to a blip.
   */
  it('classifies deterministic failures as NOT retryable', () => {
    for (const code of ['ERR_SCHEMA_INVALID', 'ERR_XSD_INVALID', 'ERR_NATURA_REQUIRED',
                        'ERR_VALIDATION_PEC_REQUIRED', 'ERR_MESSAGE_TOO_LARGE',
                        'ERR_VALIDATION_SIGNATURE_REQUIRED', 'ERR_TRANSFORM_FAILED',
                        'ERR_CONFLICT_NS_RETRY', 'ERR_GONE']) {
      expect(ERRORS[code as keyof typeof ERRORS]?.retryable, code).toBe(false);
    }
  });

  it('classifies transient failures as retryable', () => {
    // ERR_CHANNEL_CREDIT: nothing was sent and topping up fixes it — failing it
    // permanently would lose every invoice queued while the wallet was empty.
    for (const code of ['ERR_CHANNEL_UNAVAILABLE', 'ERR_CHANNEL_TIMEOUT', 'ERR_CHANNEL_CREDIT',
                        'ERR_RATE_LIMITED', 'ERR_INTERNAL']) {
      expect(ERRORS[code as keyof typeof ERRORS]?.retryable, code).toBe(true);
    }
  });

  it('an auth failure never discloses which part was wrong', () => {
    // Identical shape for missing, invalid, expired and revoked: anything else
    // tells an attacker whether a key exists.
    for (const c of ['ERR_AUTH_MISSING', 'ERR_AUTH_INVALID',
                     'ERR_AUTH_EXPIRED', 'ERR_AUTH_REVOKED']) {
      expect(ERRORS[c as keyof typeof ERRORS].http).toBe(401);
    }
  });

  it('a cross-tenant miss is 404, never 403', () => {
    // 403 would confirm the resource exists inside another tenant.
    expect(ERRORS.ERR_NOT_FOUND.http).toBe(404);
  });

  it('serialises to the documented envelope shape', () => {
    const e = new ApiError('ERR_NOT_FOUND', 'submission');
    const j = e.toJSON() as { error: { code: string; message: string; retryable: boolean } };
    expect(j.error.code).toBe('ERR_NOT_FOUND');
    expect(j.error.retryable).toBe(false);
  });

  it('carries structured details when supplied', () => {
    const e = new ApiError('ERR_SCHEMA_INVALID', undefined, [{ path: 'number', message: 'too long' }]);
    const j = e.toJSON() as { error: { details?: unknown[] } };
    expect(j.error.details).toHaveLength(1);
  });

  it('is documented — every code appears in the reference', () => {
    const docs = readFileSync('docs/api/errors.md', 'utf8');
    const undocumented = Object.keys(ERRORS).filter((c) => !docs.includes(c));
    expect(undocumented, 'these codes are not in docs/api/errors.md').toEqual([]);
  });
});
