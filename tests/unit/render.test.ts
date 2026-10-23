import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderNotification, RenderError } from '../../src/infra/render/xslt.ts';

const read = (f: string) => readFileSync(`tests/fixtures/official/${f}`, 'utf8');

describe('official AdE stylesheet rendering', () => {
  it('renders NS with every data field present', async () => {
    const html = await renderNotification(read('IT01234567890_11111_NS_001.xml'), 'NS');
    const text = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
    expect(text).toContain('111');
    expect(text).toContain('IT01234567890_11111.xml.p7m');
    expect(text).toContain('00100');
    expect(text).toContain('Certificato di firma scaduto');
  });

  it('the benign "only 1.1 features" stderr warning is NOT treated as failure', async () => {
    // Every AdE stylesheet declares version="1.1" and triggers this warning.
    const html = await renderNotification(read('IT01234567890_11111_RC_001.xml'), 'RC');
    expect(html.length).toBeGreaterThan(500);
  });

  it.each(['RC', 'NS', 'MC', 'NE', 'DT', 'AT', 'MT', 'EC', 'SE'])(
    'renders %s', async (t) => {
      const html = await renderNotification(read(`IT01234567890_11111_${t}_001.xml`), t);
      expect(html.length).toBeGreaterThan(300);
    },
  );

  it('rejects an unknown notification type', async () => {
    await expect(renderNotification('<x/>', 'ZZ')).rejects.toThrow(RenderError);
  });
});
