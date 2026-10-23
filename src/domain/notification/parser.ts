import libxml from 'libxmljs2';

/**
 * SdI notification parser.
 *
 * Driven by MessaggiTypes_v1.1.xsd (namespace http://www.fatturapa.gov.it/sdi/messaggi/v1.0)
 * and validated against the nine official examples in tests/fixtures/official/.
 *
 * NINE root elements exist, not six. Six are addressed to the *transmitter*
 * (that is PASSO's outbound flow); three — MT / EC / SE — belong to the
 * inbound-reception flow and are v2 scope. They must still be RECOGNISED so a
 * legitimate message arriving in a PEC mailbox is quarantined rather than
 * treated as corruption.
 */

export const SDI_NS = 'http://www.fatturapa.gov.it/sdi/messaggi/v1.0';

export const NOTIFICATION_TYPE = {
  RC: 'RC', NS: 'NS', MC: 'MC', NE: 'NE', DT: 'DT', AT: 'AT',
  MT: 'MT', EC: 'EC', SE: 'SE',
} as const;
export type NotificationType = (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];

/** Root element -> type code. Verified against MessaggiTypes_v1.1.xsd. */
const ROOT_TO_TYPE: Record<string, NotificationType> = {
  RicevutaConsegna: 'RC',
  NotificaScarto: 'NS',
  NotificaMancataConsegna: 'MC',
  NotificaEsito: 'NE',
  NotificaDecorrenzaTermini: 'DT',
  AttestazioneTrasmissioneFattura: 'AT',
  MetadatiInvioFile: 'MT',
  NotificaEsitoCommittente: 'EC',
  ScartoEsitoCommittente: 'SE',
};

/** Types addressed to the transmitter — the only ones that drive submission state in MVP. */
export const TRANSMITTER_TYPES: ReadonlySet<NotificationType> =
  new Set(['RC', 'NS', 'MC', 'NE', 'DT', 'AT']);

export interface SdiError { codice: string; descrizione: string | null }

export interface ParsedNotification {
  type: NotificationType;
  isTransmitterType: boolean;
  identificativoSdI: string | null;
  nomeFile: string | null;
  messageId: string | null;
  /** Correlates a notification back to the outbound PEC message. Present on transmitter types. */
  pecMessageId: string | null;
  dataOraRicezione: string | null;
  /** NS only. A rejection carries a LIST of errors, never a single code. */
  errors: SdiError[];
  /** NE / EC only: EC01 accepted, EC02 rejected. */
  esito: string | null;
  /** SE only. */
  scarto: string | null;
  descrizione: string | null;
  note: string | null;
  /** True when the document carries an embedded ds:Signature (SdI signs NS and SE). */
  signed: boolean;
  raw: string;
}

export class NotificationParseError extends Error {
  readonly raw: string | undefined;
  constructor(message: string, raw?: string) { super(message); this.raw = raw; }
}

/**
 * Parse with XXE defence. Notification XML is externally supplied — over PEC it
 * arrives as an email attachment from an unauthenticated sender.
 */
function parseSafe(xml: string): libxml.Document {
  let doc: libxml.Document;
  try {
    doc = libxml.parseXml(xml, {
      noent: false,    // do NOT expand entities (XXE defence)
      nonet: true,     // no network fetch for external entities
      dtdload: false,  // do not load external DTD
      dtdvalid: false,
      noblanks: false,
    });
  } catch (e) {
    throw new NotificationParseError(`XML parse failed: ${(e as Error).message}`, xml);
  }
  if (!doc?.root()) throw new NotificationParseError('document has no root element', xml);
  return doc;
}

/**
 * libxmljs2's `Node` type does not declare `text()` / `get()`, although both
 * exist at runtime on element nodes. This narrow shim keeps the cast in one
 * place instead of scattering `as any` through the parser.
 */
interface XmlNode { text(): string; get(xpath: string): XmlNode | undefined }
const asNode = (n: unknown): XmlNode | undefined => (n as XmlNode | undefined) ?? undefined;

const textOf = (doc: libxml.Document, name: string): string | null => {
  // Notifications carry a namespace prefix; match on local-name to stay prefix-agnostic.
  const t = asNode(doc.get(`//*[local-name()="${name}"]`))?.text()?.trim();
  return t ? t : null;
};

/**
 * Unwrap OpenAPI.it's notification envelope.
 *
 * Asked for `application/xml`, `GET /invoices_notifications/{uuid}` returns
 * the GENUINE SdI receipts, each inside a CDATA section of a vendor wrapper:
 *
 *   <response><item key="{notification uuid}"><![CDATA[<RicevutaConsegna …>]]></item></response>
 *
 * (labelled `text/html` — so the content type is not trusted). The wrapper is
 * parsed with the same XXE-hardened options as a receipt, and each payload is
 * returned for `parseNotification`, so a vendor receipt goes through exactly
 * the parser a PEC receipt does. Observed live against the sandbox 2026-10-01.
 */
export function unwrapVendorNotifications(xml: string): Array<{ key: string; xml: string }> {
  const doc = parseSafe(xml);
  const root = doc.root()!.name();
  if (root !== 'response') {
    throw new NotificationParseError(`unexpected vendor wrapper root "${root}"`, xml);
  }
  return doc.find('/response/item').map((raw) => {
    const n = raw as unknown as { attr(name: string): { value(): string } | null; text(): string };
    return { key: n.attr('key')?.value() ?? '', xml: n.text().trim() };
  });
}

export function parseNotification(xml: string): ParsedNotification {
  const doc = parseSafe(xml);
  const rootName = doc.root()!.name();
  const type = ROOT_TO_TYPE[rootName];
  if (!type) {
    throw new NotificationParseError(
      `unknown notification root element "${rootName}" — quarantine, do not discard`, xml,
    );
  }

  const errors: SdiError[] = doc
    .find('//*[local-name()="ListaErrori"]/*[local-name()="Errore"]')
    .map((raw) => {
      const n = asNode(raw);
      return {
        codice: n?.get('*[local-name()="Codice"]')?.text()?.trim() ?? '',
        descrizione: n?.get('*[local-name()="Descrizione"]')?.text()?.trim() ?? null,
      };
    })
    .filter((e) => e.codice !== '');

  return {
    type,
    isTransmitterType: TRANSMITTER_TYPES.has(type),
    identificativoSdI: textOf(doc, 'IdentificativoSdI'),
    nomeFile: textOf(doc, 'NomeFile'),
    messageId: textOf(doc, 'MessageId'),
    pecMessageId: textOf(doc, 'PecMessageId'),
    dataOraRicezione: textOf(doc, 'DataOraRicezione'),
    errors,
    esito: textOf(doc, 'Esito'),
    scarto: textOf(doc, 'Scarto'),
    descrizione: textOf(doc, 'Descrizione'),
    note: textOf(doc, 'Note'),
    signed: doc.find('//*[local-name()="Signature"]').length > 0,
    raw: xml,
  };
}

/** Filename grammar: {IdPaese}{IdCodice}_{ProgressivoInvio}_{TYPE}_{NNN}.xml */
const FILENAME_RE = /^([A-Z]{2}[A-Za-z0-9]+)_([A-Za-z0-9]{1,10})_([A-Z]{2})_(\d+)\.xml$/;

export interface ParsedFilename {
  transmitterId: string; progressivoInvio: string;
  type: NotificationType; sequence: number;
}

export function parseNotificationFilename(name: string): ParsedFilename | null {
  const m = FILENAME_RE.exec(name);
  if (!m) return null;
  const type = ROOT_TO_TYPE[Object.keys(ROOT_TO_TYPE).find((k) => ROOT_TO_TYPE[k] === m[3]) ?? ''];
  const code = m[3] as NotificationType;
  if (!Object.values(NOTIFICATION_TYPE).includes(code)) return null;
  return {
    transmitterId: m[1]!, progressivoInvio: m[2]!,
    type: type ?? code, sequence: Number(m[4]),
  };
}
