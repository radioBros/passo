# Italian E-invoicing Primer

Background for developers who have integrated e-invoicing elsewhere. If you are coming from Peppol, UBL or a generic EDI stack, the assumptions that transfer are fewer than you expect.

::: warning Not tax advice
This page describes a file format and a message flow. It is not advice on your tax obligations. Consult a *commercialista*.
:::

## The moving parts

**Agenzia delle Entrate (AdE)** is the Italian revenue agency. It publishes the FatturaPA schema, the XSD files and the XSL stylesheets PASSO bundles.

**Sistema di Interscambio (SdI)** is the clearing system every Italian electronic invoice passes through. This is a *clearance* model, not a post-audit one: the invoice is transmitted to SdI, SdI validates and forwards it, and until SdI has accepted it the invoice is **not legally issued**. There is no route from seller to buyer that goes around it.

**FatturaPA** is the XML format. "PA" is historical — the format started with public-administration invoicing and was later extended to B2B and B2C. Both use the same schema.

## FatturaPA is not UBL

The single most expensive assumption to carry in. FatturaPA shares no element names, no namespace, no document structure and no code lists with UBL or CII. An existing UBL mapping is worth nothing here except as a rough field inventory.

The root element is `<p:FatturaElettronica>`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica
    xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2"
    xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
    versione="FPR12">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>…</DatiTrasmissione>
    <CedentePrestatore>…</CedentePrestatore>
    <CessionarioCommittente>…</CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>…</DatiGenerali>
    <DatiBeniServizi>…</DatiBeniServizi>
    <DatiPagamento>…</DatiPagamento>
  </FatturaElettronicaBody>
</p:FatturaElettronica>
```

Note that only the root carries a namespace prefix. The children are unqualified.

`FatturaElettronicaBody` is repeatable — a single transmission may carry a *lotto* of several invoices sharing one header. PASSO emits exactly one body per submission.

### The namespace is `v1.2`, not `v1.2.3`

```
http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2
```

::: danger The version-number trap
The schema *file* is `Schema_VFPR12_v1.2.3.xsd`. The *namespace* inside it is `.../fatture/v1.2`. The namespace is deliberately stable across patch revisions of the schema; only the filename moves.

Emitting `.../fatture/v1.2.3` produces a document that is well-formed, looks correct to a human, and is rejected **universally** — every invoice, every time, with a schema error that points at the root element and explains nothing useful.
:::

PASSO hardcodes the correct value in one place:

```ts
// src/infra/render/xsd.ts
export const INVOICE_NS = 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2';
```

### One schema, two flavours

`Schema_VFPR12_v1.2.3.xsd` (private) and `Schema_VFPA12_V1.2.3.xsd` (public administration) are **byte-identical** — same MD5. B2B and B2G differ only by the value of `FormatoTrasmissione` inside the document, never by schema. PASSO validates both against the one bundled file.

## FormatoTrasmissione: FPR12 vs FPA12

`FormatoTrasmissione` appears twice — as the root's `versione` attribute and as an element inside `DatiTrasmissione` — and both must agree.

| Value | Recipient | `CodiceDestinatario` |
|---|---|---|
| **FPR12** | Private — B2B and B2C | **7** characters, e.g. `ABC1234` |
| **FPA12** | Public administration — B2G | **6** characters, the IPA code |

The recipient-code length is not cosmetic; it is how you tell the two apart at a glance, and PASSO enforces it:

```ts
.refine((i) => (i.format === 'FPA12' ? i.recipientCode.length === 6 : true),
  { message: 'PA recipients (FPA12) use a 6-character IPA code' })
```

### `0000000` — the unknown-recipient code

Seven zeroes mean "the recipient has no accredited channel registered." SdI then delivers by making the invoice available in the recipient's *Cassetto fiscale*, and you are expected to supply a PEC address:

```json
{ "recipientCode": "0000000", "recipientPec": "cliente@pec.example.it" }
```

Omitting `recipientPec` with that code is `400 ERR_VALIDATION_PEC_REQUIRED`.

### B2G brings extra obligations

Invoices to a public administration generally require **CIG** (*Codice Identificativo Gara*, the tender identifier) and/or **CUP** (*Codice Unico di Progetto*, the project identifier). Both live inside `DatiOrdineAcquisto`, never at document top level:

```xml
<DatiOrdineAcquisto>
  <IdDocumento>2026/0042</IdDocumento>
  <CodiceCUP>J51B09000000001</CodiceCUP>
  <CodiceCIG>0123456789</CodiceCIG>
</DatiOrdineAcquisto>
```

B2G also requires a **qualified electronic signature** (CAdES, producing a `.p7m`). PASSO holds no qualified certificate and never will — see [SdI channels](/integrations/channels) for the two ways to satisfy this.

## The nine notification types

SdI answers with a notification. There are nine root elements, not the six most integration guides list, and knowing all nine is what stops PASSO treating a legitimate message as corruption.

### Six address the transmitter

These drive your submission's state. They are what PASSO's outbound flow consumes.

| Code | Element | Meaning | Terminal | Legally issued? |
|---|---|---|---|---|
| **RC** | `RicevutaConsegna` | Delivered to the recipient | yes | yes |
| **NS** | `NotificaScarto` | **Rejected by SdI** | yes | **no** |
| **MC** | `NotificaMancataConsegna` | Not yet delivered; SdI still trying | no | **yes** |
| **NE** | `NotificaEsito` | The PA accepted or rejected (B2G) | yes | yes |
| **DT** | `NotificaDecorrenzaTermini` | The PA did not respond in time (B2G) | yes | yes |
| **AT** | `AttestazioneTrasmissioneFattura` | Transmission attested; delivery impossible | yes | yes |

### Three address the receiver (v2 scope)

| Code | Element | Belongs to |
|---|---|---|
| **MT** | `MetadatiInvioFile` | Receiving invoices addressed to you |
| **EC** | `NotificaEsitoCommittente` | The buyer's accept/reject response |
| **SE** | `ScartoEsitoCommittente` | SdI rejecting a malformed EC |

Inbound reception is not implemented. PASSO **recognises** these three and quarantines them with an explanatory reason, rather than failing the parse. A legitimate message landing in a PEC mailbox must never be mistaken for a corrupt attachment:

```ts
if (!n.isTransmitterType) {
  await quarantine(db, n, channel,
    `receiver-flow notification (${n.type}) — inbound reception is v2`);
}
```

### NS is terminal — the mistake that matters most

An `NS` means SdI refused the file. The invoice is **legally not issued**: it does not exist for tax purposes, and there is no state in which retrying it produces a different outcome.

The correct response is to fix the defect and submit a **new** invoice, which gets a **new** `ProgressivoInvio`. PASSO refuses the alternative:

```
POST /api/v1/invoices/{id}/retry
409 ERR_CONFLICT_NS_RETRY
```

Resubmitting the same `ProgressivoInvio` yields a duplicate rejection, because SdI has already seen that progressivo. Resubmitting a *corrected* invoice under a fresh progressivo is the intended path.

An `NS` carries a **list** of errors, never a single code:

```xml
<ListaErrori>
  <Errore>
    <Codice>00100</Codice>
    <Descrizione>Certificato di firma scaduto</Descrizione>
  </Errore>
  <Errore>
    <Codice>00423</Codice>
    <Descrizione>PrezzoTotale non calcolato correttamente</Descrizione>
  </Errore>
</ListaErrori>
```

Reading only the first one means fixing one defect, resubmitting, and being rejected again for the second.

### MC is not a failure

::: warning MC looks like an error and is the opposite
`NotificaMancataConsegna` means SdI accepted the invoice and **could not yet deliver it** to the recipient — a full mailbox, an unreachable endpoint, a temporarily dead channel.

The invoice **is legally issued**. SdI keeps trying on its own, for days. Resubmitting duplicates a document that already exists at the tax authority.

PASSO's webhook says so explicitly, and `/retry` refuses with `409 ERR_CONFLICT_MC_RETRY`:

```json
{ "notificationType": "MC", "legallyIssued": true,
  "retryable": false, "action": "none_required" }
```

The exact duration of SdI's delivery-retry window is **[UNVERIFIED]** — PASSO implements no timer for it and simply waits for SdI's next notification.
:::

### NE and DT are B2G-only

After delivery to a public administration, the PA has a window in which to accept or reject:

- **NE** with `Esito` = `EC01` → accepted → state `accepted_by_pa`
- **NE** with `Esito` = `EC02` → rejected → state `rejected_by_pa`
- **DT** → the window elapsed with no response → state `delivered`

`EC02` is a **commercial** dispute, not a schema failure. The invoice was validly issued; the PA is contesting its content. That is a business conversation, not a resubmission.

The exact length of the PA response window before DT is **[UNVERIFIED]** in this codebase; no timer is implemented for it either.

### AT: transmission attested

`AttestazioneTrasmissioneFattura` means SdI could not deliver at all and is handing you a signed attestation that you transmitted correctly. Retain it as evidence — it is the document that proves you met your obligation.

## ProgressivoInvio

A per-transmission sequence number allocated by the transmitter (that is, by PASSO — never by the caller).

- **Type**: `String10Type` — 1 to 10 basic-Latin characters.
- **Uniqueness**: unique per transmitter, forever.
- **On NS**: a corrected resubmission **must** get a new value.

::: tip Ten characters, not five
Some third-party documentation states a 5-character limit. The XSD says 1..10. PASSO encodes base-36 and pads to 5 characters by default, which stays comfortably inside the real limit while remaining short enough to read in a filename.
:::

The allocation is a monotonic per-transmitter counter, never `COUNT(*) + 1`:

```sql
INSERT INTO progressivo_counters (transmitter_id, next_value)
VALUES ($1, 0) ON CONFLICT (transmitter_id) DO NOTHING;

UPDATE progressivo_counters
   SET next_value = next_value + 1, updated_at = now()
 WHERE transmitter_id = $1
 RETURNING next_value;
```

An NS retry burns a value and leaves a gap. `COUNT(*) + 1` would then collide with a row that already exists — caught by the unique constraint, but only after the transaction had done its work. A counter that only moves forward makes gaps irrelevant. The `UPDATE … RETURNING` takes a row lock, which serialises concurrent allocators for the same transmitter without an explicit advisory lock.

## Filename conventions

**Invoices:**

```
{IdPaese}{IdCodice}_{ProgressivoInvio}.xml
IT01234567890_0002P.xml
IT01234567890_0002P.xml.p7m      # when signed (CAdES)
```

**Notifications** add the type and a sequence number:

```
{IdPaese}{IdCodice}_{ProgressivoInvio}_{TYPE}_{NNN}.xml
IT01234567890_0002P_RC_001.xml
```

The filename is not decoration. Over PEC it is the message subject and the attachment name, and it is one of the ways a receipt is correlated back to its submission.

## Money is a patterned string

FatturaPA amounts are **strings matching a regex**, not numbers. This is where most integrations break.

Verified against `Schema_VFPR12_v1.2.3.xsd`:

| Type | Pattern | Used for |
|---|---|---|
| `Amount2DecimalType` | `[\-]?[0-9]{1,11}\.[0-9]{2}` | `ImponibileImporto`, `Imposta`, `PrezzoTotale`, totals |
| `Amount8DecimalType` | `[\-]?[0-9]{1,11}\.[0-9]{2,8}` | `PrezzoUnitario` |
| `RateType` | `[0-9]{1,3}\.[0-9]{2}` | `AliquotaIVA`, max `100.00` |
| `QuantitaType` | `[0-9]{1,12}\.[0-9]{2,8}` | `Quantita` |

Three consequences:

1. **The decimal part is mandatory in the XML.** `<PrezzoTotale>1000</PrezzoTotale>` is schema-invalid. `1000.00` is valid.
2. **Maximum 11 integer digits** — not "any decimal".
3. **`AliquotaIVA` is a decimal percent.** 22% is `22.00`. Never `22`, never basis points, never `0.22`.

PASSO always emits the padded form; see [Invoice data model](/api/invoice-model) for the input rules.

## Natura: why a zero rate needs a reason

An `AliquotaIVA` of `0.00` is not self-explanatory — Italian VAT law distinguishes many different reasons for charging no VAT, and the tax authority wants to know which one applies. `Natura` is that reason code.

`N1`–`N7` with sub-codes, 24 values in total. The rule is symmetric and PASSO enforces both directions:

- `vatRate` is `"0.00"` → `nature` is **required**
- `nature` is set → `vatRate` **must** be `"0.00"`

A non-zero rate with a Natura is as invalid as a zero rate without one.

## Signature

B2G invoices require a qualified electronic signature in CAdES form, producing a `.p7m` envelope around the XML.

PASSO holds no qualified certificate. The supported path is **a channel that signs server-side**: OpenAPI.it with `"requestSigning": true`. Supplying your own pre-signed `.p7m` is not supported yet.

PEC cannot sign. Submitting an `FPA12` invoice over PEC without a signature is refused at validation with `ERR_VALIDATION_SIGNATURE_REQUIRED` rather than transmitted unsigned to a public administration.

## Rendering

AdE publishes official XSL stylesheets — the same ones the tax portal uses to display an invoice. PASSO bundles them and applies them with `xsltproc`, so `GET /invoices/{id}/rendered` shows exactly what a tax inspector would see. There is one stylesheet per `FormatoTrasmissione` and one per notification type.

## Further reading

- [Invoice data model](/api/invoice-model) — every field and every enum value
- [Notifications & webhooks](/api/webhooks) — the notification contract
- [SdI channels](/integrations/channels) — how transmission actually happens
