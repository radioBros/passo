import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  PecChannel, SDI_FIRST_ADDRESS, PEC_MAX_BYTES,
  estimateMessageBytes, detectAssignedAddress,
} from '../../src/infra/channels/pec.ts';
import { ChannelError } from '../../src/infra/channels/types.ts';

describe('PEC rotating SdI address — silent-failure trap', () => {
  it('first submission uses sdi01@', () => {
    expect(SDI_FIRST_ADDRESS).toBe('sdi01@pec.fatturapa.it');
  });
  it('detects the assigned address from an SdI reply', () => {
    expect(detectAssignedAddress('"SDI" <sdi02@pec.fatturapa.it>')).toBe('sdi02@pec.fatturapa.it');
    expect(detectAssignedAddress('sdi56@pec.fatturapa.it')).toBe('sdi56@pec.fatturapa.it');
  });
  it('does NOT treat sdi01@ as an assignment (that is the default)', () => {
    expect(detectAssignedAddress('sdi01@pec.fatturapa.it')).toBeNull();
  });
  it('ignores unrelated senders', () => {
    expect(detectAssignedAddress('noreply@example.com')).toBeNull();
    expect(detectAssignedAddress(undefined)).toBeNull();
  });
});

describe('PEC 30 MB limit', () => {
  it('accounts for base64 inflation (~33%), not raw size', () => {
    expect(estimateMessageBytes(3_000_000)).toBeGreaterThan(4_000_000);
  });
  it('rejects an oversized message before sending', async () => {
    const ch = new PecChannel();
    const huge = 'x'.repeat(23 * 1024 * 1024);
    await expect(ch.submit(
      { tenantId: 't', submissionId: 's', xml: huge, filename: 'f.xml', signed: false },
      { smtpHost: 'h', smtpPort: 465, imapHost: 'h', imapPort: 993, user: 'u', password: 'p' },
    )).rejects.toThrow(ChannelError);
  });
  it('the limit is exactly 30 MB', () => {
    expect(PEC_MAX_BYTES).toBe(30 * 1024 * 1024);
  });
});

describe('PEC capabilities', () => {
  it('CANNOT sign — B2G over PEC needs a caller-supplied .p7m', () => {
    expect(new PecChannel().capabilities.serverSideSigning).toBe(false);
  });
  it('is poll-based, not push', () => {
    expect(new PecChannel().capabilities.pushNotifications).toBe(false);
  });
});

/**
 * SEC-040 — TLS is mandatory and NOT configurable.
 *
 * A safe default is not a control. `imapSecure: false` in a tenant config would
 * have sent the mailbox PASSWORD in plaintext — and a PEC password grants full
 * access to every legal receipt plus the ability to send as the taxpayer, with
 * no way for PASSO to revoke it.
 */
describe('PEC transport security', () => {
  const raw = readFileSync('src/infra/channels/pec.ts', 'utf8');
  // Strip comments: the doc block deliberately QUOTES the removed field to
  // explain why it is gone, and matching prose would be a false positive.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('offers NO configuration field that could disable TLS', () => {
    // The fields existed and defaulted to true; a default is overridable.
    expect(src).not.toMatch(/smtpSecure\??:/);
    expect(src).not.toMatch(/imapSecure\??:/);
    expect(src).not.toMatch(/secure:\s*c\./);
  });

  it('pins secure: true on every connection', () => {
    const conns = src.match(/new ImapFlow\(\{[\s\S]*?\}\)/g) ?? [];
    expect(conns.length).toBeGreaterThan(0);
    for (const c of conns) expect(c).toMatch(/TLS_IMAP/);
  });

  it('REJECTS an untrusted certificate — otherwise the TLS is decorative', () => {
    // An attacker who can answer the DNS gets the password anyway if a
    // self-signed or wrong-hostname certificate is accepted.
    expect(src).toMatch(/rejectUnauthorized:\s*true/);
    expect(src).not.toMatch(/rejectUnauthorized:\s*false/);
  });

  it('sets a TLS floor rather than accepting whatever the server offers', () => {
    expect(src).toMatch(/minVersion:\s*'TLSv1\.2'/);
  });

  it('requires TLS on SMTP too, not just IMAP', () => {
    expect(src).toMatch(/requireTLS:\s*true/);
  });
});

/**
 * SEC-041 — MIME parsing limits.
 *
 * This is the most exposed parse site in PASSO: the input is an email from an
 * untrusted sender, parsed BEFORE correlation — so before the tenant is known,
 * and therefore before any per-tenant quota could apply. Every limit bounds
 * work an attacker controls, in the process that collects legal receipts for
 * every tenant on the instance.
 */
describe('MIME parsing limits', () => {
  const raw = readFileSync('src/infra/channels/pec.ts', 'utf8');

  it('caps the whole message before parsing it', () => {
    // Checking after parsing would be checking after the memory was spent.
    expect(raw).toMatch(/maxMessageBytes/);
    expect(raw).toMatch(/msg\.source\.length > MIME_LIMITS\.maxMessageBytes/);
  });

  it('caps a single attachment', () => {
    expect(raw).toMatch(/att\.content\.length > MIME_LIMITS\.maxAttachmentBytes/);
  });

  it('caps the NUMBER of attachments — a real receipt carries one or two', () => {
    expect(raw).toMatch(/slice\(0, MIME_LIMITS\.maxAttachments\)/);
  });

  it('bounds parse time, so a decompression bomb is abandoned', () => {
    expect(raw).toMatch(/parseWithTimeout/);
    expect(raw).toMatch(/parseTimeoutMs/);
  });

  it('SKIPS rather than discards — an unparseable message may still be a receipt', () => {
    /**
     * Behavioural, not prose: every limit branch must `continue`, never delete
     * or acknowledge. A skipped message stays unread, so it is re-fetched and
     * an operator can see it; deleting one would not be recoverable.
     */
    const body = /async poll\([\s\S]*?\n {2}\}/.exec(raw)?.[0] ?? '';
    expect(body).toBeTruthy();
    expect(body).not.toMatch(/messageDelete|messageFlagsAdd|\\\\Seen/);
    // Each guard bails out of the iteration rather than handling the message.
    expect((body.match(/continue;/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('sets the message ceiling above SdI 30MB limit, not below', () => {
    // Below it would reject legitimate maximum-size invoices.
    const m = /maxMessageBytes:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(raw);
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(30);
  });
});

/**
 * One definition of the PEC message, shared by the real send and by
 * scripts/pec-preview.mjs — so the .eml an operator inspects is what SdI gets.
 */
describe('buildPecMessage', () => {
  it('attaches the invoice under its FatturaPA file name, byte-for-byte', async () => {
    const { buildPecMessage } = await import('../../src/infra/channels/pec.ts');
    const xml = '<?xml version="1.0"?><p:FatturaElettronica/>';
    const m = buildPecMessage({ xml, filename: 'IT01234567897_00001.xml' }, 'a@pec.it', 'sdi01@pec.fatturapa.it');
    expect(m.to).toBe('sdi01@pec.fatturapa.it');
    expect(m.subject).toBe('IT01234567897_00001.xml');
    expect(m.attachments).toEqual([
      { filename: 'IT01234567897_00001.xml', content: xml, contentType: 'application/xml' },
    ]);
  });

  it('the PEC channel transmits exactly what buildPecMessage builds', () => {
    // Source-level: a second, hand-built message in submit() is how drift starts.
    const src = readFileSync('src/infra/channels/pec.ts', 'utf8');
    const submit = /async submit\([\s\S]*?\n {2}\}/.exec(src)?.[0] ?? '';
    expect(submit).toMatch(/sendMail\(buildPecMessage\(/);
    expect(submit).not.toMatch(/attachments:/);
  });
});
