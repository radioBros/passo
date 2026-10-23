import { create } from 'xmlbuilder2';
import type { Invoice, Party } from './model.ts';
import { toDecimal, fmtAmount, fmtUnitPrice, fmtRate, fmtQuantita } from '../../shared/util/money.ts';
import { INVOICE_NS } from '../../infra/render/xsd.ts';

/**
 * FatturaPA XML generator.
 *
 * Root is <p:FatturaElettronica> in namespace
 *   http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2
 * (v1.2 — NOT v1.2.3; the namespace is stable across patch revisions).
 *
 * FatturaPA is NOT UBL. The `versione` attribute carries FormatoTrasmissione.
 * FatturaElettronicaBody is repeatable (lotto); MVP emits exactly one.
 */

export interface TransmissionMeta {
  /** PASSO-owned. Country + code of the transmitting party. */
  transmitterCountry: string;
  transmitterCode: string;
  /** PASSO-allocated, <=10 basic-Latin chars, unique per transmitter, NEW on every NS retry. */
  progressivoInvio: string;
}

function anagrafica(node: ReturnType<typeof create>, p: Party): void {
  const a = node.ele('Anagrafica');
  if (p.name) a.ele('Denominazione').txt(p.name);
  else { a.ele('Nome').txt(p.firstName!); a.ele('Cognome').txt(p.lastName!); }
}

function sede(node: ReturnType<typeof create>, p: Party): void {
  const s = node.ele('Sede');
  s.ele('Indirizzo').txt(p.address.street);
  if (p.address.streetNumber) s.ele('NumeroCivico').txt(p.address.streetNumber);
  s.ele('CAP').txt(p.address.postalCode);
  s.ele('Comune').txt(p.address.city);
  if (p.address.province) s.ele('Provincia').txt(p.address.province);
  s.ele('Nazione').txt(p.address.country);
}

export function generateInvoiceXml(inv: Invoice, meta: TransmissionMeta): string {
  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('p:FatturaElettronica', {
      'xmlns:p': INVOICE_NS,
      'xmlns:ds': 'http://www.w3.org/2000/09/xmldsig#',
      versione: inv.format,
    });

  // ---------- FatturaElettronicaHeader ----------
  const header = root.ele('FatturaElettronicaHeader');

  const dt = header.ele('DatiTrasmissione');
  const idt = dt.ele('IdTrasmittente');
  idt.ele('IdPaese').txt(meta.transmitterCountry);
  idt.ele('IdCodice').txt(meta.transmitterCode);
  dt.ele('ProgressivoInvio').txt(meta.progressivoInvio);
  dt.ele('FormatoTrasmissione').txt(inv.format);
  dt.ele('CodiceDestinatario').txt(inv.recipientCode);
  if (inv.recipientPec) dt.ele('PECDestinatario').txt(inv.recipientPec);

  const cp = header.ele('CedentePrestatore');
  const cpDati = cp.ele('DatiAnagrafici');
  const cpIva = cpDati.ele('IdFiscaleIVA');
  cpIva.ele('IdPaese').txt(inv.seller.vatId!.country);
  cpIva.ele('IdCodice').txt(inv.seller.vatId!.code);
  if (inv.seller.taxCode) cpDati.ele('CodiceFiscale').txt(inv.seller.taxCode);
  anagrafica(cpDati, inv.seller);
  cpDati.ele('RegimeFiscale').txt(inv.seller.taxRegime!);
  sede(cp, inv.seller);

  const cc = header.ele('CessionarioCommittente');
  const ccDati = cc.ele('DatiAnagrafici');
  if (inv.buyer.vatId) {
    const ccIva = ccDati.ele('IdFiscaleIVA');
    ccIva.ele('IdPaese').txt(inv.buyer.vatId.country);
    ccIva.ele('IdCodice').txt(inv.buyer.vatId.code);
  }
  if (inv.buyer.taxCode) ccDati.ele('CodiceFiscale').txt(inv.buyer.taxCode);
  anagrafica(ccDati, inv.buyer);
  sede(cc, inv.buyer);

  // ---------- FatturaElettronicaBody ----------
  const body = root.ele('FatturaElettronicaBody');

  const dg = body.ele('DatiGenerali');
  const dgd = dg.ele('DatiGeneraliDocumento');
  dgd.ele('TipoDocumento').txt(inv.documentType);
  dgd.ele('Divisa').txt(inv.currency);
  dgd.ele('Data').txt(inv.date);
  dgd.ele('Numero').txt(inv.number);
  // XSD sequence: Numero, DatiRitenuta, DatiBollo, DatiCassaPrevidenziale, ...
  if (inv.stampDuty) {
    const bollo = dgd.ele('DatiBollo');
    bollo.ele('BolloVirtuale').txt('SI');
    bollo.ele('ImportoBollo').txt(fmtAmount(toDecimal(inv.stampDuty.amount, 'stampDuty.amount')));
  }

  // CIG/CUP live inside DatiOrdineAcquisto — never at document top level.
  if (inv.cig || inv.cup || inv.purchaseOrderId) {
    const doa = dg.ele('DatiOrdineAcquisto');
    if (inv.purchaseOrderId) doa.ele('IdDocumento').txt(inv.purchaseOrderId);
    else doa.ele('IdDocumento').txt(inv.number);
    if (inv.cup) doa.ele('CodiceCUP').txt(inv.cup);
    if (inv.cig) doa.ele('CodiceCIG').txt(inv.cig);
  }

  /**
   * Contract, convention and reception references (XML-015).
   *
   * Structurally identical to DatiOrdineAcquisto and required by a PA that
   * issued the invoice against one of them — omitting it earns an NS, which is
   * terminal and needs a brand-new invoice.
   */
  if (inv.contractId) {
    const dc = dg.ele('DatiContratto');
    dc.ele('IdDocumento').txt(inv.contractId);
    if (inv.cup) dc.ele('CodiceCUP').txt(inv.cup);
    if (inv.cig) dc.ele('CodiceCIG').txt(inv.cig);
  }
  if (inv.conventionId) {
    const dcv = dg.ele('DatiConvenzione');
    dcv.ele('IdDocumento').txt(inv.conventionId);
    if (inv.cup) dcv.ele('CodiceCUP').txt(inv.cup);
    if (inv.cig) dcv.ele('CodiceCIG').txt(inv.cig);
  }
  if (inv.receptionId) {
    const dr = dg.ele('DatiRicezione');
    dr.ele('IdDocumento').txt(inv.receptionId);
  }

  const dbs = body.ele('DatiBeniServizi');
  for (const l of inv.lines) {
    const dl = dbs.ele('DettaglioLinee');
    dl.ele('NumeroLinea').txt(String(l.lineNumber));
    dl.ele('Descrizione').txt(l.description);
    if (l.quantity) dl.ele('Quantita').txt(fmtQuantita(toDecimal(l.quantity, 'quantity')));
    if (l.unitOfMeasure) dl.ele('UnitaMisura').txt(l.unitOfMeasure);
    dl.ele('PrezzoUnitario').txt(fmtUnitPrice(toDecimal(l.unitPrice, 'unitPrice')));
    dl.ele('PrezzoTotale').txt(fmtAmount(toDecimal(l.totalPrice, 'totalPrice')));
    dl.ele('AliquotaIVA').txt(fmtRate(toDecimal(l.vatRate, 'vatRate')));
    if (l.nature) dl.ele('Natura').txt(l.nature);
  }
  for (const s of inv.summaries) {
    const dr = dbs.ele('DatiRiepilogo');
    dr.ele('AliquotaIVA').txt(fmtRate(toDecimal(s.vatRate, 'summary.vatRate')));
    if (s.nature) dr.ele('Natura').txt(s.nature);
    dr.ele('ImponibileImporto').txt(fmtAmount(toDecimal(s.taxableAmount, 'taxableAmount')));
    dr.ele('Imposta').txt(fmtAmount(toDecimal(s.taxAmount, 'taxAmount')));
    if (s.vatCollectability) dr.ele('EsigibilitaIVA').txt(s.vatCollectability);
    if (s.lawReference) dr.ele('RiferimentoNormativo').txt(s.lawReference);
  }

  if (inv.payment) {
    const dp = body.ele('DatiPagamento');
    dp.ele('CondizioniPagamento').txt(inv.payment.conditions);
    const ddp = dp.ele('DettaglioPagamento');
    ddp.ele('ModalitaPagamento').txt(inv.payment.method);
    if (inv.payment.dueDate) ddp.ele('DataScadenzaPagamento').txt(inv.payment.dueDate);
    if (inv.payment.amount) {
      ddp.ele('ImportoPagamento').txt(fmtAmount(toDecimal(inv.payment.amount, 'payment.amount')));
    }
    if (inv.payment.iban) ddp.ele('IBAN').txt(inv.payment.iban);
  }

  /**
   * Allegati — attachments (XML-019).
   *
   * MUST come last in FatturaElettronicaBody: the XSD fixes element order, and
   * an out-of-order element fails schema validation, which is a pre-submission
   * gate rather than an SdI rejection.
   *
   * The file is carried base64 INSIDE the XML, so it counts against the same
   * 30 MB channel limit as the invoice — the model caps the decoded total to
   * leave room.
   */
  for (const att of inv.attachments ?? []) {
    const al = body.ele('Allegati');
    al.ele('NomeAttachment').txt(att.name);
    if (att.format) al.ele('FormatoAttachment').txt(att.format);
    if (att.description) al.ele('DescrizioneAttachment').txt(att.description);
    al.ele('Attachment').txt(att.content);
  }

  return root.end({ prettyPrint: true });
}

/** Filename: {IdPaese}{IdCodice}_{ProgressivoInvio}.xml  (.xml.p7m when signed) */
export function invoiceFileName(meta: TransmissionMeta, signed = false): string {
  const base = `${meta.transmitterCountry}${meta.transmitterCode}_${meta.progressivoInvio}.xml`;
  return signed ? `${base}.p7m` : base;
}
