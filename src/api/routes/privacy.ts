import { Router, type Request, type Response, type NextFunction } from 'express';
import { createHash } from 'node:crypto';
import { withTenant, audit } from '../../infra/db/pool.ts';
import { decrypt } from '../../infra/crypto/keys.ts';
import { renderInvoice } from '../../infra/render/xslt.ts';
import { ApiError } from '../../shared/errors/catalog.ts';
import { requireScope } from '../middleware/auth.ts';
import type { Deps } from './invoices.ts';

/**
 * Data-subject surfaces (SEC-028 / SEC-029).
 *
 * PASSO is a relay, not an archive, which changes both of these fundamentally
 * from their usual shape:
 *
 *   - **Erasure** is mostly a matter of answering accurately about a very small
 *     surface. There is no 10-year retention duty to weigh against the request,
 *     because there is no archive — the CRM holds that and its obligation.
 *     In-flight documents are the one refusal, and NOT for retention reasons:
 *     deleting a document mid-exchange with SdI orphans the receipt without
 *     recalling anything from the tax authority.
 *
 *   - **Export** is what makes purge safe. Because PASSO destroys the payload
 *     once a terminal receipt arrives, the CRM must be able to take everything
 *     before that happens. Hashes are computed over the PLAINTEXT XML bytes, so
 *     the recipient can verify them independently against the file they hold.
 */

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

const param = (req: Request, name: string): string => {
  const v = req.params[name];
  if (typeof v !== 'string' || v === '') throw new ApiError('ERR_SCHEMA_INVALID', `missing :${name}`);
  return v;
};

const sha256 = (b: Buffer | string): string =>
  createHash('sha256').update(b).digest('hex');

export function privacyRoutes(d: Deps): Router {
  const r = Router();

  /**
   * GET /api/v1/invoices/{id}/export — the pre-purge fetch package.
   *
   * Everything PASSO holds for one submission, in one call, hash-verifiable.
   * Once a terminal receipt arrives the payload is purged and this returns
   * `410 Gone`: there is no recovery path afterwards, and that absence is
   * exactly what keeps PASSO outside the conservazione obligation.
   */
  r.get('/invoices/:id/export', requireScope('invoices:read'), wrap(async (req, res) => {
    const id = param(req, 'id');
    const tenantId = req.tenantId!;

    const data = await withTenant(d.db, tenantId, async (tx) => {
      const s = await tx.query<{
        id: string; state: string; progressivo_invio: string; xml_filename: string;
        channel: string; identificativo_sdi: string | null; purged_at: Date | null;
        submitted_at: Date | null; terminal_at: Date | null; created_at: Date;
        signature_present: boolean; xml_sha256: string | null;
        xml_encrypted: Buffer | null; xml_key_version: string | null;
        xml_iv: Buffer | null; xml_tag: Buffer | null;
        invoice_number: string; document_type: string; issue_date: Date;
      }>(
        `SELECT s.id, s.state, s.progressivo_invio, s.xml_filename, s.channel,
                s.identificativo_sdi, s.purged_at, s.submitted_at, s.terminal_at,
                s.created_at, s.signature_present, s.xml_sha256,
                s.xml_encrypted, s.xml_key_version, s.xml_iv, s.xml_tag,
                i.invoice_number, i.document_type, i.issue_date
           FROM sdi_submissions s JOIN invoices i ON i.id = s.invoice_id
          WHERE s.id = $1`, [id]);
      if (!s.rows[0]) return null;
      const n = await tx.query(
        `SELECT type, received_at, acknowledged_at, parsed
           FROM notifications WHERE submission_id = $1 ORDER BY received_at`, [id]);
      return { sub: s.rows[0], notifications: n.rows };
    });

    if (!data) throw new ApiError('ERR_NOT_FOUND', 'submission');
    const s = data.sub;
    if (!s.xml_encrypted) {
      // 410, not 404: it existed, and telling the caller so is the difference
      // between "you got the id wrong" and "you were too late".
      throw new ApiError('ERR_GONE',
        `purged after reaching state "${s.state}" — PASSO holds no archive, ` +
        'the export must be taken before the terminal receipt arrives');
    }

    const xml = decrypt(d.keys, {
      ciphertext: s.xml_encrypted, iv: s.xml_iv!, tag: s.xml_tag!,
      keyVersion: s.xml_key_version!,
    }, tenantId, 'xml');

    let rendered: string | null;
    try {
      // The stylesheet is chosen by FormatoTrasmissione, which is inside the
      // document itself — B2G and B2B render differently.
      const formato = /<FormatoTrasmissione>([^<]+)</.exec(xml.toString('utf8'))?.[1] ?? 'FPR12';
      rendered = await renderInvoice(xml.toString('utf8'), formato);
    } catch {
      // A rendering failure must not deny the caller the XML itself, which is
      // the part with legal weight.
      rendered = null;
    }

    await withTenant(d.db, tenantId, (tx) => audit(tx, {
      tenantId, actor: `apikey:${req.keyId ?? 'unknown'}`, action: 'submission.export',
      resourceType: 'submission', resourceId: id,
    }));

    res.json({
      submissionId: s.id,
      invoice: {
        number: s.invoice_number, documentType: s.document_type,
        issueDate: s.issue_date, progressivoInvio: s.progressivo_invio,
        fileName: s.xml_filename, signed: s.signature_present,
      },
      transmission: {
        channel: s.channel, state: s.state, identificativoSdI: s.identificativo_sdi,
        submittedAt: s.submitted_at, terminalAt: s.terminal_at, createdAt: s.created_at,
      },
      // Hashes over the PLAINTEXT bytes, so the recipient can verify them
      // against the file they hold without knowing anything about our storage.
      xml: xml.toString('utf8'),
      hashes: {
        xmlSha256: sha256(xml),
        recordedSha256: s.xml_sha256,
        algorithm: 'sha256',
        note: 'Computed over the plaintext XML bytes, not the stored ciphertext.',
      },
      rendered,
      notifications: data.notifications,
      exportedAt: new Date().toISOString(),
      requestId: req.requestId,
    });
  }));

  /**
   * POST /api/v1/privacy/erasure — answer accurately about a small surface.
   *
   * Deliberately does not perform a deletion. The honest answer is almost
   * always "PASSO holds nothing for this subject; the CRM is the controller of
   * the archive" — and for an in-flight document the refusal is about the live
   * exchange with SdI, never about a retention duty PASSO does not have.
   */
  r.post('/privacy/erasure', requireScope('invoices:read'), wrap(async (req, res) => {
    const tenantId = req.tenantId!;
    const b = req.body as { vatId?: string; taxCode?: string; subjectRef?: string };
    if (!b?.vatId && !b?.taxCode && !b?.subjectRef) {
      throw new ApiError('ERR_SCHEMA_INVALID',
        'supply vatId, taxCode or subjectRef to identify the data subject');
    }

    const inFlight = await withTenant(d.db, tenantId, (tx) => tx.query<{
      id: string; state: string; created_at: Date;
    }>(
      `SELECT s.id, s.state, s.created_at
         FROM sdi_submissions s
        WHERE s.purged_at IS NULL AND s.terminal_at IS NULL
        ORDER BY s.created_at`));

    const unacked = await withTenant(d.db, tenantId, (tx) => tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifications WHERE acknowledged_at IS NULL`));

    await withTenant(d.db, tenantId, (tx) => audit(tx, {
      tenantId, actor: `apikey:${req.keyId ?? 'unknown'}`, action: 'privacy.erasure_request',
      resourceType: 'tenant', resourceId: tenantId,
      detail: { inFlight: inFlight.rows.length },
    }));

    res.json({
      subject: { vatId: b.vatId ?? null, taxCode: b.taxCode ?? null, subjectRef: b.subjectRef ?? null },
      holds: {
        archive: false,
        inFlightDocuments: inFlight.rows.length,
        unacknowledgedReceipts: unacked.rows[0]!.n,
        auditEntries: 'operational forensics only, expires on its own schedule',
      },
      erasable: inFlight.rows.length === 0,
      controller:
        'The CRM is the controller of the invoice archive. PASSO is a relay: it holds ' +
        'tenant configuration and transient in-flight payloads, not a record of past ' +
        'invoices. Direct the erasure request to the CRM.',
      ...(inFlight.rows.length > 0 ? {
        refusal: {
          reason: 'transmission_in_flight',
          explanation:
            'These documents are mid-exchange with the Sistema di Interscambio. Deleting ' +
            "PASSO's copy now would orphan the receipt without recalling anything from the " +
            'tax authority — SdI is an independent controller and holds its own copy under ' +
            'Italian law. This is NOT a retention-duty refusal: PASSO holds no archive.',
          documents: inFlight.rows.map((x) => ({
            submissionId: x.id, state: x.state,
            // The expected purge point, so the requester knows when it resolves.
            expectedPurge: 'on arrival of a terminal receipt, then acknowledgement plus the grace window',
          })),
        },
      } : {}),
      auditLog: {
        erasable: false,
        reason:
          'The audit log is hash-chained precisely so entries cannot be removed without ' +
          'detection. It carries actors and actions, not invoice content, and expires on ' +
          'its own retention schedule.',
      },
      requestId: req.requestId,
    });
  }));

  return r;
}
