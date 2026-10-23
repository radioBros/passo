import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import type {
  SdiChannelAdapter, SubmitInput, SubmitResult, PolledNotification, PoisonMessage, PollResult,
} from './types.ts';
import { ChannelError, connectionDelivery } from './types.ts';
import { parseNotification } from '../../domain/notification/parser.ts';

/**
 * PEC channel — the zero-cost path. The operator brings their own accredited
 * PEC mailbox; PASSO operates a full mail client.
 *
 * TWO facts verified at fatturapa.gov.it that make this channel different:
 *
 * 1. THE ADDRESS ROTATES.
 *    First submission goes to sdi01@pec.fatturapa.it. SdI then replies with a
 *    per-transmitter address that ALL later submissions must use:
 *      "il Sistema, con il primo messaggio di risposta ... comunica al
 *       trasmittente l'indirizzo di PEC che dovra utilizzare per i successivi
 *       eventuali invii"
 *      "L'utilizzo di un indirizzo di PEC diverso da quello assegnato dal SdI
 *       non garantisce il buon fine della ricezione del file FatturaPA"
 *    Continuing to use sdi01@ raises NO error — delivery is merely "not
 *    guaranteed". Silent non-receipt of a tax document is the worst available
 *    failure, so the assigned address is LEARNED STATE, never configuration.
 *
 * 2. 30 MB HARD LIMIT, message including attachment:
 *      "Il messaggio, comprensivo dell'allegato, non deve superare la
 *       dimensione di 30 megabytes."
 *
 * IMAP, never POP3: POP3 deletes on read, so a crash mid-processing loses a
 * legal receipt permanently — and the mailbox is the only copy.
 */

export const SDI_FIRST_ADDRESS = 'sdi01@pec.fatturapa.it';
export const PEC_MAX_BYTES = 30 * 1024 * 1024;

/**
 * TLS is MANDATORY and not configurable (SEC-040).
 *
 * `secure` was previously caller-overridable with a safe default. A default is
 * not a control: a tenant config carrying `imapSecure: false` would send the
 * mailbox PASSWORD in plaintext — and a PEC password grants full access to
 * every legal receipt plus the ability to send as the taxpayer, and PASSO
 * cannot revoke it.
 *
 * `rejectUnauthorized` is pinned too. Accepting a self-signed or wrong-hostname
 * certificate makes the TLS decorative: an attacker who can answer the DNS gets
 * the password anyway.
 *
 * A provider that cannot do implicit TLS on 993/465 is not usable here, and
 * failing to connect is the correct outcome — silently downgrading would look
 * identical to working.
 */
/**
 * MIME parsing limits (SEC-041).
 *
 * This is the MOST EXPOSED parse site in PASSO. The input is an email from an
 * untrusted sender, and it is parsed BEFORE correlation — so before the tenant
 * is even known, which means before any per-tenant quota could apply.
 *
 * Every limit here bounds work an attacker controls. Without them a single
 * message can exhaust the poller's memory, and the poller is what collects
 * legal receipts for every tenant on the instance.
 */
const MIME_LIMITS = {
  /** A whole message. SdI's own ceiling is 30MB; anything larger is not SdI. */
  maxMessageBytes: 32 * 1024 * 1024,
  /** One attachment. The invoice plus its attachments must fit 30MB anyway. */
  maxAttachmentBytes: 30 * 1024 * 1024,
  /** A real receipt carries one or two XML files, never dozens. */
  maxAttachments: 20,
  /** Bounds a decompression bomb: parsing must finish or be abandoned. */
  parseTimeoutMs: 30_000,
} as const;

/** Abandon a parse that will not finish, rather than blocking the poll cycle. */
async function parseWithTimeout(source: Buffer): Promise<ReturnType<typeof simpleParser>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      simpleParser(source),
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`MIME parse exceeded ${MIME_LIMITS.parseTimeoutMs}ms — abandoned`)),
          MIME_LIMITS.parseTimeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const TLS_IMAP = {
  secure: true,
  tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const },
} as const;

const TLS_SMTP = {
  secure: true,
  requireTLS: true,
  tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' as const },
} as const;

export interface PecConfig {
  smtpHost: string; smtpPort: number;
  imapHost: string; imapPort: number;
  user: string; password: string;
  /** Learned from SdI's first reply. Defaults to the first-contact address. */
  sdiAddress?: string;
}

/** Base64 inflates ~33%; check the ENCODED size, not the raw XML length. */
export function estimateMessageBytes(xmlBytes: number, overheadBytes = 8 * 1024): number {
  return Math.ceil(xmlBytes * 4 / 3) + overheadBytes;
}

/**
 * Detect the address SdI assigned for future submissions.
 * Called on EVERY inbound SdI message, because the assignment arrives with the
 * first response — a receipt or a rejection, whichever comes first.
 */
export function detectAssignedAddress(from: string | undefined): string | null {
  if (!from) return null;
  const m = /(sdi\d{2,}@pec\.fatturapa\.it)/i.exec(from);
  if (!m) return null;
  const addr = m[1]!.toLowerCase();
  return addr === SDI_FIRST_ADDRESS ? null : addr;
}

/**
 * The exact message PASSO sends to SdI over PEC — ONE definition, used by the
 * real send and by `scripts/pec-preview.mjs`, so what an operator inspects as
 * an .eml cannot drift from what is transmitted.
 *
 * The invoice travels as an attachment named by the FatturaPA filename rule
 * (`{IdPaese}{IdCodice}_{ProgressivoInvio}.xml`, or `.xml.p7m` when signed).
 * The PEC provider then wraps this message in its signed transport envelope —
 * that envelope is the provider's, not PASSO's.
 */
export function buildPecMessage(
  input: { xml: string; filename: string }, from: string, to: string,
): { from: string; to: string; subject: string; text: string;
     attachments: Array<{ filename: string; content: string; contentType: string }> } {
  return {
    from, to,
    subject: input.filename,
    text: 'Invio fattura elettronica',
    attachments: [{ filename: input.filename, content: input.xml, contentType: 'application/xml' }],
  };
}

export const PEC_SMTP_TLS = TLS_SMTP;

export class PecChannel implements SdiChannelAdapter {
  readonly name = 'pec';
  readonly capabilities = {
    // PEC cannot sign on our behalf: there is no vendor between PASSO and SdI.
    serverSideSigning: false,
    pushNotifications: false,
    maxMessageBytes: PEC_MAX_BYTES,
  };

  willSign(): boolean { return false; }

  async submit(input: SubmitInput, config: Record<string, unknown>): Promise<SubmitResult> {
    const c = config as unknown as PecConfig;
    const xmlBytes = Buffer.byteLength(input.xml, 'utf8');
    const estimated = estimateMessageBytes(xmlBytes);
    if (estimated > PEC_MAX_BYTES) {
      // ERR_MESSAGE_TOO_LARGE, not a PEC-specific code: the 30MB limit is
      // SdI's and applies to every channel. A separate code would have an
      // integrator write two handlers for one condition.
      throw new ChannelError(
        `PEC message ~${estimated} bytes exceeds SdI's 30 MB limit — base64 and MIME ` +
        'overhead inflate the invoice, and attachments count against the same budget',
        false, 'ERR_MESSAGE_TOO_LARGE',
      );
    }

    const to = c.sdiAddress ?? SDI_FIRST_ADDRESS;
    const transport = nodemailer.createTransport({
      host: c.smtpHost, port: c.smtpPort, ...TLS_SMTP,
      auth: { user: c.user, pass: c.password },
      requireTLS: true,
    });

    try {
      const info = await transport.sendMail(buildPecMessage(input, c.user, to));
      return {
        // The Message-ID correlates SdI's reply back to this submission.
        ...(info.messageId ? { pecMessageId: info.messageId } : {}),
        acceptedAt: new Date(),
      };
    } catch (e) {
      // Connection, DNS, TLS or auth failures happen before DATA: not sent.
      // Anything later (a dropped connection after DATA) may have been accepted.
      const rc = (e as { responseCode?: number }).responseCode;
      throw new ChannelError(`PEC send failed: ${(e as Error).message}`,
        true, 'ERR_CHANNEL_UNAVAILABLE',
        rc && rc >= 400 && rc < 600 ? 'not_sent' : connectionDelivery(e));
    } finally {
      transport.close();
    }
  }

  /**
   * Fetch UNSEEN messages and extract notification XML.
   *
   * \Seen is set ONLY after the caller has durably persisted the notification —
   * see markSeen. A crash between fetch and persist must re-fetch, not lose.
   *
   * A message that cannot be processed is returned as `poison`, never silently
   * skipped. Skipping left it unread, so it was re-downloaded and re-parsed on
   * every poll forever; and a bad attachment beside a good one was LOST when
   * the good one acknowledged the whole message.
   */
  async poll(config: Record<string, unknown>): Promise<PollResult> {
    const c = config as unknown as PecConfig;
    const client = new ImapFlow({
      host: c.imapHost, port: c.imapPort, ...TLS_IMAP,
      auth: { user: c.user, pass: c.password }, logger: false,
    });
    const out: PolledNotification[] = [];
    const poison: PoisonMessage[] = [];
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
        if (!msg.source) continue;
        const handle = String(msg.uid);

        /**
         * Refuse an oversized message BEFORE parsing it. Parsing is where the
         * memory goes, so checking afterwards would be checking too late.
         */
        if (msg.source.length > MIME_LIMITS.maxMessageBytes) {
          // SdI never sends anything this large: an attack or a provider fault.
          // Only a bounded head is kept — storing the whole thing is the
          // resource exhaustion the limit exists to prevent.
          poison.push({ receiptHandle: handle, raw: msg.source.subarray(0, 64 * 1024).toString('utf8'),
                        reason: `message exceeds ${MIME_LIMITS.maxMessageBytes} bytes ` +
                                `(${msg.source.length}); first 64KB kept` });
          continue;
        }

        let mail;
        try {
          mail = await parseWithTimeout(msg.source);
        } catch (e) {
          // It may still be a legal receipt, so the raw bytes are kept.
          poison.push({ receiptHandle: handle, raw: msg.source.toString('utf8'),
                        reason: `MIME parse failed: ${(e as Error).message}` });
          continue;
        }

        const attachments = (mail.attachments ?? []).slice(0, MIME_LIMITS.maxAttachments);
        for (const att of attachments) {
          const name = att.filename ?? '';
          if (!/\.xml$/i.test(name)) continue;
          if (att.content.length > MIME_LIMITS.maxAttachmentBytes) {
            poison.push({ receiptHandle: handle, filename: name,
                          raw: att.content.subarray(0, 64 * 1024).toString('utf8'),
                          reason: `XML attachment exceeds ${MIME_LIMITS.maxAttachmentBytes} bytes` });
            continue;
          }
          try {
            // The UID rides along so the caller can mark this message read
            // only once the notification is durably stored.
            out.push({ ...parseNotification(att.content.toString('utf8')), receiptHandle: handle });
          } catch (e) {
            poison.push({ receiptHandle: handle, filename: name, raw: att.content.toString('utf8'),
                          reason: `not a parseable SdI notification: ${(e as Error).message}` });
          }
        }
      }
    } finally {
      lock.release();
      await client.logout().catch(() => undefined);
    }
    return { notifications: out, poison };
  }

  /**
   * Credentials and IMAP reachability (SDI-020).
   *
   * The PEC failure that matters is silent: the poller stops, receipts stop
   * arriving, and nothing errors anywhere. Connecting and authenticating is
   * exactly the step that breaks when a mailbox password is rotated at the
   * provider — which PASSO cannot detect any other way.
   */
  async health(config: Record<string, unknown>): Promise<{
    ok: boolean; checked: string; latencyMs?: number; error?: string;
  }> {
    const c = config as unknown as PecConfig;
    const started = Date.now();
    const client = new ImapFlow({
      host: c.imapHost, port: c.imapPort, ...TLS_IMAP,
      auth: { user: c.user, pass: c.password }, logger: false,
    });
    try {
      await client.connect();
      await client.logout();
      return { ok: true, checked: 'IMAP connect + authenticate', latencyMs: Date.now() - started };
    } catch (e) {
      return {
        ok: false, checked: 'IMAP connect + authenticate', latencyMs: Date.now() - started,
        // The message may embed the connection URI, so it is not echoed raw.
        error: (e as Error).message.replace(/:\/\/[^@\s]*@/, '://[redacted]@'),
      };
    }
  }

  /**
   * Mark messages `\Seen`, and ONLY now.
   *
   * Until this runs the message stays unread, so a crash anywhere between fetch
   * and persist causes a re-fetch rather than the permanent loss of a legal
   * receipt. Re-ingesting is harmless — ingest is idempotent on
   * IdentificativoSdI — whereas losing a receipt is not recoverable.
   */
  async acknowledge(config: Record<string, unknown>, receipts: string[]): Promise<void> {
    if (receipts.length === 0) return;
    const c = config as unknown as PecConfig;
    const client = new ImapFlow({
      host: c.imapHost, port: c.imapPort, ...TLS_IMAP,
      auth: { user: c.user, pass: c.password }, logger: false,
    });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageFlagsAdd(receipts.join(','), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
      await client.logout().catch(() => undefined);
    }
  }
}
