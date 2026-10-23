import { isIP } from 'node:net';
import { describe, it, expect } from 'vitest';
import {
  isBlockedIp, validateWebhookUrl, SsrfError, signWebhook, verifyWebhook, pinnedDispatcher } from '../../src/domain/webhook/security.ts';

describe('SSRF protection', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
  ])('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true));

  it('blocks the cloud metadata endpoint specifically', () => {
    expect(isBlockedIp('169.254.169.254')).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34'])('allows public %s', (ip) =>
    expect(isBlockedIp(ip)).toBe(false));

  it('blocks IPv6 loopback, unique-local and link-local', () => {
    expect(isBlockedIp('::1')).toBe(true);
    expect(isBlockedIp('fd00::1')).toBe(true);
    expect(isBlockedIp('fe80::1')).toBe(true);
  });

  it('blocks IPv4-mapped IPv6 loopback', () => {
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects http in production mode', async () => {
    await expect(validateWebhookUrl('http://example.com/hook')).rejects.toThrow(SsrfError);
  });

  it('rejects credentials embedded in the URL', async () => {
    await expect(validateWebhookUrl('https://u:p@example.com/hook')).rejects.toThrow(SsrfError);
  });

  it('rejects a literal private IP', async () => {
    await expect(validateWebhookUrl('https://127.0.0.1/hook')).rejects.toThrow(SsrfError);
    await expect(validateWebhookUrl('https://169.254.169.254/latest/meta-data'))
      .rejects.toThrow(SsrfError);
  });

  it('returns the RESOLVED ip so the caller can pin it (DNS-rebinding defence)', async () => {
    const r = await validateWebhookUrl('https://1.1.1.1/hook');
    expect(r.ip).toBe('1.1.1.1');
  });
});

describe('HMAC signing', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ eventType: 'invoice.delivered' });

  it('round-trips', () => {
    expect(verifyWebhook(body, signWebhook(body, secret), secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyWebhook(`${body} `, signWebhook(body, secret), secret)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifyWebhook(body, signWebhook(body, secret), 'other')).toBe(false);
  });

  it('rejects a stale timestamp (replay defence)', () => {
    const old = signWebhook(body, secret, Date.now() - 10 * 60_000);
    expect(verifyWebhook(body, old, secret)).toBe(false);
  });

  it('does NOT throw on a malformed or short signature', () => {
    // timingSafeEqual throws on unequal lengths — a naive verifier crashes here.
    expect(() => verifyWebhook(body, 't=1,v1=ab', secret)).not.toThrow();
    expect(verifyWebhook(body, 't=1,v1=ab', secret)).toBe(false);
    expect(verifyWebhook(body, 'garbage', secret)).toBe(false);
    expect(verifyWebhook(body, '', secret)).toBe(false);
  });
});

/**
 * SEC-017 — the connection must go to the address that passed validation.
 *
 * Validating a hostname and then calling `fetch(url)` lets the runtime resolve
 * again at connect time, so a hostile DNS record can answer public during the
 * check and private a moment later. Narrowing that window is not closing it;
 * pinning the resolved IP removes the second resolution entirely.
 */
describe('DNS rebinding — pinned dispatcher', () => {
  it('validation returns the resolved IP, not just the URL', async () => {
    const r = await validateWebhookUrl('https://example.com/hook');
    expect(r.ip).toBeTruthy();
    expect(isIP(r.ip)).toBeGreaterThan(0);
  });

  /**
   * Behavioural proof rather than introspection: a local server is started on
   * 127.0.0.1, and the dispatcher is pinned to it while the request names a
   * completely different host. If the pin works the request reaches the local
   * server — which is exactly the redirection an attacker would achieve, and
   * exactly why the pinned address must come from validation, never from the URL.
   */
  it('connects to the PINNED address, ignoring what the hostname resolves to', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => { res.writeHead(200); res.end('pinned'); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    const dispatcher = pinnedDispatcher('127.0.0.1');
    const { fetch: undiciFetch } = await import('undici');
    // example.com does NOT resolve to 127.0.0.1 — only the pin sends it there.
    const res = await undiciFetch(`http://example.com:${port}/`, { dispatcher });
    expect(await res.text()).toBe('pinned');

    await dispatcher.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('preserves the original Host header so TLS and vhosts still work', async () => {
    const { createServer } = await import('node:http');
    let seenHost = '';
    const server = createServer((req, res) => {
      seenHost = req.headers.host ?? '';
      res.writeHead(200); res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;

    const dispatcher = pinnedDispatcher('127.0.0.1');
    const { fetch: undiciFetch } = await import('undici');
    await undiciFetch(`http://example.com:${port}/`, { dispatcher });
    // The connection went to the pinned IP, but the request still says example.com.
    expect(seenHost).toBe(`example.com:${port}`);

    await dispatcher.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
});
