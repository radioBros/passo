import { createHmac, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Agent } from 'undici';
import { isIP } from 'node:net';

/**
 * Webhook security.
 *
 * callback_url is user-supplied, so the dispatcher is an SSRF primitive unless
 * private ranges are blocked AND the resolved IP is pinned. Blocking by
 * hostname alone loses to DNS rebinding: the name resolves public at validation
 * time and private at request time.
 */

const BLOCKED_V4: ReadonlyArray<readonly [number, number]> = [
  [0x00000000, 0xff000000],   // 0.0.0.0/8
  [0x7f000000, 0xff000000],   // 127.0.0.0/8
  [0x0a000000, 0xff000000],   // 10.0.0.0/8
  [0xac100000, 0xfff00000],   // 172.16.0.0/12
  [0xc0a80000, 0xffff0000],   // 192.168.0.0/16
  [0xa9fe0000, 0xffff0000],   // 169.254.0.0/16 link-local (cloud metadata)
  [0x64400000, 0xffc00000],   // 100.64.0.0/10 CGNAT
];

const toInt = (ip: string): number =>
  ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;

export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const n = toInt(ip);
    return BLOCKED_V4.some(([base, mask]) => ((n & mask) >>> 0) === base);
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('fc') || s.startsWith('fd')) return true;   // unique local
    if (s.startsWith('fe80')) return true;                        // link-local
    const m = /::ffff:(\d+\.\d+\.\d+\.\d+)/.exec(s);              // IPv4-mapped
    if (m) return isBlockedIp(m[1]!);
    return false;
  }
  return true;   // not an IP at all
}

export class SsrfError extends Error {}

/**
 * Validate and RESOLVE. Returns the pinned IP so the caller connects to the
 * address that was actually checked — closing the rebinding window.
 */
export async function validateWebhookUrl(
  raw: string, opts: { allowHttp?: boolean } = {},
): Promise<{ url: URL; ip: string }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SsrfError('callback URL is not a valid URL'); }

  if (url.protocol !== 'https:' && !(opts.allowHttp && url.protocol === 'http:')) {
    throw new SsrfError('callback URL must use https');
  }
  if (url.username || url.password) throw new SsrfError('credentials in URL are not permitted');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new SsrfError(`callback URL resolves to a blocked address: ${host}`);
    return { url, ip: host };
  }
  let addr: { address: string };
  try { addr = await lookup(host); }
  catch { throw new SsrfError(`callback host does not resolve: ${host}`); }
  if (isBlockedIp(addr.address)) {
    throw new SsrfError(`callback host resolves to a blocked address: ${addr.address}`);
  }
  return { url, ip: addr.address };
}

/**
 * A dispatcher pinned to an already-validated IP.
 *
 * Validating the hostname and then calling `fetch(url)` leaves a real gap: the
 * runtime performs its OWN resolution when it connects, so an attacker
 * controlling the DNS record can answer public at validation and private
 * milliseconds later at connect — classic DNS rebinding. Narrowing that window
 * is not closing it.
 *
 * Overriding `lookup` makes the connection use the exact address that passed
 * validation, so there is no second resolution to poison. The Host header still
 * carries the original hostname, so TLS and virtual hosting behave normally.
 */
export function pinnedDispatcher(ip: string): Agent {
  const family = isIP(ip) === 6 ? 6 : 4;
  return new Agent({
    connect: {
      // undici calls dns.lookup with `all: true`, so the callback takes an
      // ARRAY of addresses. Handing it (err, address, family) — the ordinary
      // dns.lookup shape — fails at connect time with "Invalid IP address:
      // undefined", i.e. every webhook delivery throws.
      lookup: (_hostname: string, _options: unknown, cb: (
        err: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>,
      ) => void) => { cb(null, [{ address: ip, family }]); },
    },
  });
}

/** Stripe-style signature: t=<unix>,v1=<hex>, computed over "<t>.<rawBody>". */
export function signWebhook(rawBody: string, secret: string, at = Date.now()): string {
  const t = Math.floor(at / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

/**
 * Verify a signature. Reference implementation for integrators.
 *
 * ⚠️ timingSafeEqual THROWS on strings and on unequal lengths. Both sides must
 * be Buffers and the length checked FIRST — a naive implementation crashes
 * instead of returning false.
 *
 * ⚠️ A header can carry MORE THAN ONE `v1=` value during a secret rotation
 * ("t=…,v1=<new>,v1=<old>"). Parsing the header into a map — the obvious
 * implementation — keeps only the last one, so a receiver holding the new
 * secret would reject every delivery for the whole overlap window. Every `v1`
 * must be collected and any one of them may match.
 */
export function verifyWebhook(
  rawBody: string, header: string, secret: string, toleranceSec = 300,
): boolean {
  let t: string | undefined;
  const candidates: string[] = [];
  for (const p of header.split(',')) {
    const i = p.indexOf('=');
    if (i <= 0) continue;
    const k = p.slice(0, i).trim();
    const v = p.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') candidates.push(v);
  }
  if (!t || candidates.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;   // replay window

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();

  // Every candidate is compared in constant time, and the loop does not
  // short-circuit: returning early on the first match would leak, through
  // timing, which of the two secrets verified.
  let ok = false;
  for (const c of candidates) {
    if (!/^[0-9a-f]*$/i.test(c)) continue;
    const received = Buffer.from(c, 'hex');
    if (expected.length !== received.length) continue;
    if (timingSafeEqual(expected, received)) ok = true;
  }
  return ok;
}
