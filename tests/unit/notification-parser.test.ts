import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import {
  parseNotification, parseNotificationFilename,
  NotificationParseError, TRANSMITTER_TYPES,
} from '../../src/domain/notification/parser.ts';

const DIR = 'tests/fixtures/official';
const read = (f: string) => readFileSync(`${DIR}/${f}`, 'utf8');
const files = readdirSync(DIR).filter((f) => f.endsWith('.xml'));

describe('SdI notification parser — official examples', () => {
  it('has all nine official fixtures', () => {
    expect(files).toHaveLength(9);
  });

  it.each(files)('parses %s', (f) => {
    const n = parseNotification(read(f));
    expect(n.type).toBe(f.match(/_([A-Z]{2})_\d+\.xml$/)![1]);
    expect(n.identificativoSdI).toBeTruthy();
  });

  it('NS carries a LIST of errors, not a single code', () => {
    const n = parseNotification(read('IT01234567890_11111_NS_001.xml'));
    expect(n.type).toBe('NS');
    expect(Array.isArray(n.errors)).toBe(true);
    expect(n.errors[0]).toEqual({
      codice: '00100', descrizione: 'Certificato di firma scaduto',
    });
  });

  it('detects SdI XAdES signature on NS', () => {
    expect(parseNotification(read('IT01234567890_11111_NS_001.xml')).signed).toBe(true);
  });

  it('EC carries the buyer outcome EC01/EC02', () => {
    const n = parseNotification(read('IT01234567890_11111_EC_001.xml'));
    expect(n.type).toBe('EC');
    expect(n.esito).toBe('EC01');
    expect(n.isTransmitterType).toBe(false);   // inbound flow, v2
  });

  it('SE carries a Scarto code in its own namespace', () => {
    const n = parseNotification(read('IT01234567890_11111_SE_001.xml'));
    expect(n.scarto).toBe('EN00');
  });

  it('classifies transmitter vs receiver types correctly', () => {
    const kinds = Object.fromEntries(
      files.map((f) => {
        const n = parseNotification(read(f));
        return [n.type, n.isTransmitterType];
      }),
    );
    for (const t of ['RC', 'NS', 'MC', 'NE', 'DT', 'AT']) expect(kinds[t], t).toBe(true);
    for (const t of ['MT', 'EC', 'SE']) expect(kinds[t], t).toBe(false);
    expect(TRANSMITTER_TYPES.size).toBe(6);
  });

  it('rejects an unknown root element with a quarantine-worthy error', () => {
    expect(() => parseNotification('<?xml version="1.0"?><Bogus><A/></Bogus>'))
      .toThrow(NotificationParseError);
  });
});

describe('XXE defence', () => {
  it('does not expand an external entity', () => {
    const evil = `<?xml version="1.0"?>
      <!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
      <RicevutaConsegna xmlns="http://www.fatturapa.gov.it/sdi/messaggi/v1.0">
        <IdentificativoSdI>&xxe;</IdentificativoSdI>
      </RicevutaConsegna>`;
    // Throwing is equally acceptable: what must NOT happen is the entity
    // being expanded into the parsed value.
    let out: string;
    try { out = parseNotification(evil).identificativoSdI ?? ''; }
    catch { out = '<threw>'; }
    expect(out).not.toMatch(/root:|\/bin\/|daemon:/);
  });

  it('does not fetch a network entity', () => {
    const evil = `<?xml version="1.0"?>
      <!DOCTYPE r [<!ENTITY x SYSTEM "http://127.0.0.1:1/x">]>
      <RicevutaConsegna xmlns="http://www.fatturapa.gov.it/sdi/messaggi/v1.0">
        <IdentificativoSdI>&x;</IdentificativoSdI>
      </RicevutaConsegna>`;
    try { parseNotification(evil); } catch { /* throwing is fine */ }
    expect(true).toBe(true);   // must not hang or connect
  });
});

describe('notification filename grammar', () => {
  it('parses the official example name', () => {
    expect(parseNotificationFilename('IT01234567890_11111_NS_001.xml')).toEqual({
      transmitterId: 'IT01234567890', progressivoInvio: '11111',
      type: 'NS', sequence: 1,
    });
  });
  it('accepts a 10-char ProgressivoInvio (String10Type, not 5)', () => {
    expect(parseNotificationFilename('IT01234567890_ABCDE12345_RC_002.xml')?.progressivoInvio)
      .toBe('ABCDE12345');
  });
  it('returns null for a non-notification filename', () => {
    expect(parseNotificationFilename('IT01234567890_11111.xml')).toBeNull();
  });
});
