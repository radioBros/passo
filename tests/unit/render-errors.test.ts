import { describe, it, expect } from 'vitest';
import { renderInvoice, renderNotification, stripP7m, RenderError } from '../../src/infra/render/xslt.ts';

describe('renderer error handling', () => {
  it('rejects an unknown FormatoTrasmissione', async () => {
    await expect(renderInvoice('<x/>', 'NOPE')).rejects.toThrow(RenderError);
  });

  it('rejects an unknown notification type', async () => {
    await expect(renderNotification('<x/>', 'ZZ')).rejects.toThrow(RenderError);
  });

  it('still produces the page scaffold for unmatched input', async () => {
    // The AdE stylesheets emit their HTML shell regardless of whether any
    // template matched, so "empty output" is not the failure signal — exit
    // code is. Documented here so the behaviour is not mistaken for a bug.
    const out = await renderInvoice('<?xml version="1.0"?><unrelated/>', 'FPR12');
    expect(out).toContain('<html');
    expect(out).not.toContain('unrelated');
  });

  it('has a stylesheet for every invoice format', async () => {
    for (const f of ['FPR12', 'FPA12', 'FSM10']) {
      await expect(renderInvoice('<?xml version="1.0"?><x/>', f)).resolves.toBeTypeOf('string');
    }
  });

  it('rejects malformed XML (xsltproc exits non-zero)', async () => {
    await expect(renderInvoice('<not-closed', 'FPR12')).rejects.toThrow(RenderError);
  });
});

describe('.p7m envelope stripping', () => {
  it('extracts the inner XML from a CAdES envelope', () => {
    const inner = '<?xml version="1.0"?><p:FatturaElettronica xmlns:p="urn:x"/>';
    const p7m = Buffer.concat([
      Buffer.from([0x30, 0x82, 0x01, 0x00]),   // DER prologue
      Buffer.from(inner, 'utf8'),
      Buffer.from([0x00, 0x01]),
    ]);
    expect(stripP7m(p7m).toString('utf8')).toContain('FatturaElettronica');
  });

  it('throws when no XML payload is present', () => {
    expect(() => stripP7m(Buffer.from([0x30, 0x82, 0x00]))).toThrow(RenderError);
  });
});
