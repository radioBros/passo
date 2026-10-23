import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Rendering via the OFFICIAL Agenzia delle Entrate stylesheets, applied with the
 * system `xsltproc`.
 *
 * Why a subprocess and not an in-process binding: the `libxslt` npm package no
 * longer builds — it targets V8 APIs removed from modern Node
 * ("no member named 'AccessorSignature' in namespace 'v8'"). See
 * development/decisions/runtime_stack_decision.md, 2026-09-01 validation.
 *
 * ⚠️ TRAP: xsltproc prints
 *     "xsl:version: only 1.1 features are supported"
 * on stderr for every AdE stylesheet (they declare version="1.1") and then
 * transforms correctly with exit 0. Failure is detected by EXIT CODE and empty
 * output — never by "stderr is non-empty", which would break all rendering.
 */

// Defaults mirror the zod schema in shared/config.ts. They are read lazily so a
// test can point PASSO_XSL_DIR at a fixture directory, but the authoritative
// validated values come from Config.
const XSL_DIR = process.env['PASSO_XSL_DIR'] ?? 'assets/xsl';
const TIMEOUT_MS = Number(process.env['PASSO_RENDER_TIMEOUT_MS'] ?? 10_000);
const MAX_OUTPUT = Number(process.env['PASSO_MAX_RENDER_BYTES'] ?? 8 * 1024 * 1024);

/** Invoice stylesheets, chosen by FormatoTrasmissione. */
const INVOICE_XSL: Record<string, string> = {
  FPR12: 'Foglio_di_stile_fattura_ordinaria_ver1.2.3.xsl',
  FPA12: 'Foglio_di_stile_fatturaPA_v1.2.3.xsl',
  FSM10: 'Foglio_di_stile_VFSM10_v1.0.2.xsl',
};

/** Notification stylesheets, one per type. */
const NOTIFICATION_XSL: Record<string, string> = {
  RC: 'RC_v1.0.xsl', NS: 'NS_v1.0.xsl', MC: 'MC_v1.0.xsl',
  NE: 'NE_v1.0.xsl', DT: 'DT_v1.0.xsl', AT: 'AT_v1.1.xsl',
  MT: 'MT_v1.0.xsl', EC: 'EC_v1.0.xsl', SE: 'SE_v1.0.xsl',
};

export class RenderError extends Error {}

/**
 * Refuse any document carrying a DOCTYPE (XXE defence).
 *
 * `xsltproc` has NO option that disables local entity expansion. `--nonet`
 * blocks network fetches and `--novalid` skips DTD *validation*, but a
 * `SYSTEM "file:///…"` entity is still expanded and its contents are rendered
 * into the output — verified against the bundled AdE stylesheet with exactly
 * the flags used here.
 *
 * `POST /api/v1/render` accepts caller-supplied XML and returns the rendering,
 * so without this any authenticated tenant could read any file the process can
 * read — including the environment-supplied encryption keys.
 *
 * A legitimate FatturaPA document never carries a DOCTYPE: the format is XSD-
 * defined and the AdE examples have none. Rejecting outright is therefore free,
 * and it is the only reliable defence given the tool's capabilities.
 */
const DOCTYPE = /<!DOCTYPE/i;
const ENTITY_DECL = /<!ENTITY/i;

export function assertNoDoctype(xml: string): void {
  if (DOCTYPE.test(xml) || ENTITY_DECL.test(xml)) {
    throw new RenderError(
      'the document declares a DOCTYPE or an ENTITY, which is refused: external entities ' +
      'are an arbitrary-file-read vector and a FatturaPA document never needs one',
    );
  }
}

async function transform(stylesheet: string, xml: string): Promise<string> {
  const xslPath = path.join(XSL_DIR, stylesheet);
  if (!existsSync(xslPath)) throw new RenderError(`stylesheet not bundled: ${stylesheet}`);

  // Before the subprocess sees it: xsltproc cannot be told to ignore entities.
  assertNoDoctype(xml);

  // `xsltproc <stylesheet> -` reads the document from stdin. execFile has no
  // stdin option, so spawn is required — passing `input` to execFile silently
  // leaves the child waiting on stdin until the timeout fires.
  return new Promise<string>((resolve, reject) => {
    const child = spawn('xsltproc', [
      '--nonet',        // no network fetches
      '--novalid',      // skip the DTD loading phase
      '--nodtdattr',    // no attribute defaulting from a DTD
      '--maxdepth', '2000',
      xslPath, '-',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new RenderError(`render timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_OUTPUT) {
        settled = true;
        child.kill('SIGKILL');
        clearTimeout(timer);
        reject(new RenderError('render output exceeded limit'));
        return;
      }
      stdout += c.toString('utf8');
    });
    child.stderr.resume();   // drain; the benign 1.1 warning is expected here

    child.on('error', (e: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new RenderError(
        e.code === 'ENOENT'
          ? 'xsltproc not found — install the xsltproc package'
          : `xsltproc failed: ${e.message}`,
      ));
    });

    child.on('close', (code) => {
      if (settled) return;
      clearTimeout(timer);
      // Failure is EXIT CODE + empty output. Never stderr content: the AdE
      // stylesheets always emit "xsl:version: only 1.1 features are supported".
      if (code !== 0) return reject(new RenderError(`xsltproc exited ${code}`));
      if (stdout.trim() === '') return reject(new RenderError('xsltproc produced empty output'));
      resolve(stdout);
    });

    child.stdin.on('error', () => { /* EPIPE if the child died early */ });
    child.stdin.end(xml, 'utf8');
  });
}

export async function renderInvoice(xml: string, formato: string): Promise<string> {
  const xsl = INVOICE_XSL[formato];
  if (!xsl) throw new RenderError(`no stylesheet for FormatoTrasmissione "${formato}"`);
  return transform(xsl, xml);
}

export async function renderNotification(xml: string, type: string): Promise<string> {
  const xsl = NOTIFICATION_XSL[type];
  if (!xsl) throw new RenderError(`no stylesheet for notification type "${type}"`);
  return transform(xsl, xml);
}

/** Strip a CAdES (.p7m) envelope so the inner XML can be rendered. */
export function stripP7m(buf: Buffer): Buffer {
  const start = buf.indexOf(Buffer.from('<?xml'));
  if (start === -1) throw new RenderError('no XML payload found inside .p7m envelope');
  const close = buf.lastIndexOf(Buffer.from('>'));
  return buf.subarray(start, close + 1);
}
