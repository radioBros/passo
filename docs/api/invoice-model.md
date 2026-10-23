# Invoice Data Model

The canonical shape PASSO accepts. It is deliberately **not** a mirror of FatturaPA: you send a clean structure and the generator maps it to the XML, so you never write `CedentePrestatore` or `DatiRiepilogo` by hand.

The schema is `strict()` throughout — an unknown property is a `400`, not a silently ignored field. A typo in a key name fails loudly instead of dropping data.

## Complete example

```json
{
  "sellerId": "3f1a8c22-9e4b-4a17-b0d3-77c2e5a41b09",
  "crmInvoiceRef": "SO-2026-0042",
  "mode": "async",
  "invoice": {
    "documentType": "TD01",
    "number": "2026/0042",
    "date": "2026-09-01",
    "currency": "EUR",
    "format": "FPR12",
    "recipientCode": "ABC1234",
    "seller": {
      "vatId": { "country": "IT", "code": "01234567890" },
      "name": "Fornitore S.r.l.",
      "taxRegime": "RF01",
      "address": {
        "street": "Via Roma", "streetNumber": "12",
        "postalCode": "20100", "city": "Milano",
        "province": "MI", "country": "IT"
      }
    },
    "buyer": {
      "vatId": { "country": "IT", "code": "09876543210" },
      "name": "Cliente S.p.A.",
      "address": {
        "street": "Corso Buenos Aires", "postalCode": "20124",
        "city": "Milano", "province": "MI", "country": "IT"
      }
    },
    "lines": [
      {
        "lineNumber": 1,
        "description": "Consulenza tecnica settembre 2026",
        "quantity": "10.00",
        "unitOfMeasure": "ORE",
        "unitPrice": "100.00",
        "totalPrice": "1000.00",
        "vatRate": "22.00"
      }
    ],
    "summaries": [
      {
        "vatRate": "22.00",
        "taxableAmount": "1000.00",
        "taxAmount": "220.00",
        "vatCollectability": "I"
      }
    ],
    "payment": {
      "conditions": "TP02",
      "method": "MP05",
      "dueDate": "2026-10-01",
      "amount": "1220.00",
      "iban": "IT60X0542811101000000123456"
    }
  }
}
```

## Envelope

| Field | Type | Required | Notes |
|---|---|---|---|
| `sellerId` | uuid | yes | A `sellers` row created through the Admin API |
| `invoice` | object | yes | The invoice itself |
| `crmInvoiceRef` | string | no | Opaque to PASSO; stored on the correlation record and echoed back |
| `mode` | `"async"` \| `"sync"` | no | Defaults to async |
| `syncTimeoutMs` | number | no | Capped at `SYNC_MAX_WAIT_MS` |

`crmInvoiceRef` is worth setting. It survives on the correlation record after the payload is purged, so it is how you find a submission months later using only your own identifier.

## Transmission fields

Not in this table because **you cannot send them**. `ProgressivoInvio`, `IdTrasmittente` and the filename are owned by PASSO and allocated at submission. They come back in the 202 response:

```json
{ "progressivoInvio": "0002P", "fileName": "IT01234567890_0002P.xml" }
```

The transmitter identity comes from the tenant's `transmitter_country` + `transmitter_code`. If a caller could set `ProgressivoInvio`, the per-transmitter uniqueness guarantee would be theirs to break — including by reusing one SdI has already rejected.

## Invoice

| Field | Type | Required | Notes |
|---|---|---|---|
| `documentType` | enum | no | Defaults to `TD01` |
| `number` | string(1–20) | yes | Your invoice number, e.g. `"2026/0042"` |
| `date` | `YYYY-MM-DD` | yes | A **date**, not a datetime |
| `currency` | `[A-Z]{3}` | no | Defaults to `EUR` |
| `format` | `FPR12` \| `FPA12` | **yes** | No default — the B2B/B2G choice is explicit |
| `recipientCode` | `[A-Z0-9]{6,7}` | yes | 7 private, 6 PA (IPA), or `0000000` |
| `recipientPec` | email | conditional | Required when `recipientCode` is `0000000` |
| `seller` | Party | yes | Needs `vatId` **and** `taxRegime` |
| `buyer` | Party | yes | Needs `vatId` **or** `taxCode` |
| `lines` | LineItem[] | yes | At least one |
| `summaries` | TaxSummary[] | yes | At least one |
| `payment` | Payment | no | |
| `cig` | string(≤15) | B2G | Tender identifier |
| `cup` | string(≤15) | B2G | Project identifier |
| `purchaseOrderId` | string(≤20) | no | Defaults to `number` inside `DatiOrdineAcquisto` |
| `stampDuty` | object | no | Imposta di bollo virtuale: `{ "virtual": true, "amount": "2.00" }`. Emitted as `DatiBollo`. PASSO transmits it as sent and never decides whether it is due |

::: warning `date` is a date
`"2026-09-01"` is accepted. `"2026-09-01T10:00:00Z"` is rejected. FatturaPA's `Data` has no time component, and truncating a timezone-bearing timestamp silently shifts the invoice date across midnight for some senders.
:::

`cig`, `cup` and `purchaseOrderId` all land inside `DatiOrdineAcquisto`. Supplying any one of them emits the block; `IdDocumento` falls back to the invoice `number` when `purchaseOrderId` is absent.

## Party

Used for both `seller` and `buyer`.

| Field | Type | Notes |
|---|---|---|
| `vatId` | `{ country, code }` | Partita IVA, split into two fields |
| `taxCode` | string(11–16) | Codice Fiscale |
| `name` | string(1–80) | `Denominazione` — a company |
| `firstName` / `lastName` | string(1–60) | A natural person |
| `address` | Address | Required |
| `taxRegime` | enum | `RegimeFiscale`; mandatory on the seller |

### `vatId` is two fields, not one

```json
"vatId": { "country": "IT", "code": "01234567890" }
```

::: danger Never embed the country prefix in `code`
`{ "country": "IT", "code": "IT01234567890" }` produces `<IdCodice>IT01234567890</IdCodice>` — the prefix appears twice in the document and SdI rejects it.

`IdPaese` and `IdCodice` are separate XSD elements. The model enforces this: `code` matches `/^[A-Za-z0-9]+$/` with an explicit "no country prefix" message. If your CRM stores the VAT number as one prefixed string, split it before sending.
:::

### Name or person, never both

```ts
(p) => (p.name ? !p.firstName && !p.lastName : !!(p.firstName && p.lastName))
```

Either `name` alone, or `firstName` **and** `lastName` together. Sending all three is a `400`. FatturaPA's `Anagrafica` is a choice between `Denominazione` and `Nome`+`Cognome`, and the schema will not accept both.

### Seller vs buyer requirements

**Seller** must have `vatId` and `taxRegime`. Both are separately refined with their own messages, so you learn which is missing.

**Buyer** must have `vatId` **or** `taxCode`. A private consumer has no VAT number but does have a Codice Fiscale.

## Address

| Field | Type | Required | Notes |
|---|---|---|---|
| `street` | string(1–60) | yes | `Indirizzo` |
| `streetNumber` | string(≤8) | no | `NumeroCivico` |
| `postalCode` | `\d{5}` | yes | `CAP` — exactly five digits |
| `city` | string(1–60) | yes | `Comune` |
| `province` | `[A-Z]{2}` | no | `Provincia`, e.g. `MI` |
| `country` | `[A-Z]{2}` | no | Defaults to `IT` |

`postalCode` is five digits with no separators. `"20100"` yes; `"20-100"` and `"2010"` no.

## LineItem

| Field | Type | Required | Notes |
|---|---|---|---|
| `lineNumber` | positive int | yes | `NumeroLinea` |
| `description` | string(1–1000) | yes | `Descrizione` |
| `quantity` | non-negative decimal string | no | `Quantita` |
| `unitOfMeasure` | string(≤10) | no | `UnitaMisura` |
| `unitPrice` | decimal string | yes | `PrezzoUnitario` |
| `totalPrice` | decimal string | yes | `PrezzoTotale` |
| `vatRate` | non-negative decimal string | yes | `AliquotaIVA`, a percent |
| `nature` | enum | conditional | `Natura` |

### Zero rate requires Natura, and vice versa

```ts
(l) => (Number(l.vatRate) === 0 ? !!l.nature : true)   // 0 needs a nature
(l) => (l.nature ? Number(l.vatRate) === 0 : true)     // a nature needs 0
```

A zero rate with no `nature` is `400 ERR_NATURA_REQUIRED`. A `nature` on a `"22.00"` line is equally invalid. See [the primer](/guide/fatturapa#natura-why-a-zero-rate-needs-a-reason) for why the tax authority wants the reason code.

## TaxSummary

One entry per distinct VAT rate — `DatiRiepilogo`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `vatRate` | non-negative decimal string | yes | Must match the lines it summarises |
| `nature` | enum | conditional | Same rule as lines |
| `taxableAmount` | decimal string | yes | `ImponibileImporto` |
| `taxAmount` | decimal string | yes | `Imposta` |
| `vatCollectability` | `I` \| `D` \| `S` | no | `EsigibilitaIVA` |
| `lawReference` | string(≤100) | no | `RiferimentoNormativo` |

An invoice with lines at 22% and 10% needs **two** summaries. PASSO does not compute or reconcile them for you — it emits what you send and lets the XSD and SdI have the final word.

## Payment

| Field | Type | Required | Notes |
|---|---|---|---|
| `conditions` | `TP01`–`TP03` | yes | `CondizioniPagamento` |
| `method` | `MP01`–`MP23` | yes | `ModalitaPagamento` |
| `dueDate` | `YYYY-MM-DD` | no | `DataScadenzaPagamento` |
| `amount` | decimal string | no | `ImportoPagamento` |
| `iban` | IBAN pattern | no | Validated as `[A-Z]{2}\d{2}[A-Za-z0-9]{11,30}` |

The whole `payment` object is optional; if present, `conditions` and `method` are both required.

---

# Enum values

All verified against `Schema_VFPR12_v1.2.3.xsd` and generated into `src/shared/types/fatturapa-enums.ts`. Sending anything outside these lists is `400 ERR_SCHEMA_INVALID`.

## TipoDocumento — 20 values

```
TD01 TD02 TD03 TD04 TD05 TD06
TD16 TD17 TD18 TD19 TD20 TD21 TD22 TD23 TD24 TD25 TD26 TD27 TD28 TD29
```

| Code | Meaning |
|---|---|
| `TD01` | Fattura |
| `TD02` | Acconto / anticipo su fattura |
| `TD03` | Acconto / anticipo su parcella |
| `TD04` | Nota di credito |
| `TD05` | Nota di debito |
| `TD06` | Parcella |
| `TD16`–`TD19` | Reverse-charge and self-billing documents |
| `TD20`–`TD28` | Regularisation, integration and purchase documents |
| `TD29` | Communication of omitted or irregular invoicing |

::: danger TD07–TD15 do not exist
The sequence jumps from `TD06` straight to `TD16`. `TD07` through `TD15` were never allocated in v1.2.x — a code generator that assumes a contiguous range will produce values that fail schema validation.

Conversely `TD29` **does** exist and is easy to omit if your list was built against an older revision.
:::

## Natura — 24 values

```
N1
N2  N2.1 N2.2
N3  N3.1 N3.2 N3.3 N3.4 N3.5 N3.6
N4
N5
N6  N6.1 N6.2 N6.3 N6.4 N6.5 N6.6 N6.7 N6.8 N6.9
N7
```

| Code | Meaning |
|---|---|
| `N1` | Escluse ex art. 15 |
| `N2`, `N2.1`, `N2.2` | Non soggette |
| `N3`, `N3.1`–`N3.6` | Non imponibili |
| `N4` | Esenti |
| `N5` | Regime del margine / IVA non esposta |
| `N6`, `N6.1`–`N6.9` | Inversione contabile (reverse charge) |
| `N7` | IVA assolta in altro stato UE |

::: warning The bare `N2`, `N3` and `N6` are still in the schema
They are present in the XSD and PASSO accepts them, but they are the superseded generic forms — the sub-coded values replaced them. Prefer the specific sub-code (`N3.2`, `N6.4`) unless you have a concrete reason not to. SdI or a recipient may object to the generic form even where the schema permits it.
:::

## RegimeFiscale — 19 values

```
RF01 RF02      RF04 RF05 RF06 RF07 RF08 RF09 RF10
RF11 RF12 RF13 RF14 RF15 RF16 RF17 RF18 RF19 RF20
```

::: danger RF03 does not exist
The range is `RF01`–`RF20` **minus RF03** — nineteen values, not twenty. `RF03` was withdrawn and never reinstated. Iterating `RF01..RF20` produces one value that fails validation.
:::

Common ones: `RF01` ordinario · `RF02` contribuenti minimi · `RF19` forfettario · `RF18` altro.

## ModalitaPagamento — 23 values

`MP01` through `MP23`, contiguous.

| Code | Meaning |
|---|---|
| `MP01` | Contanti |
| `MP02` | Assegno |
| `MP05` | Bonifico |
| `MP08` | Carta di pagamento |
| `MP12` | RIBA |
| `MP19` | SEPA Direct Debit |

## CondizioniPagamento — 3 values

| Code | Meaning |
|---|---|
| `TP01` | Pagamento a rate |
| `TP02` | Pagamento completo |
| `TP03` | Anticipo |

## EsigibilitaIVA — 3 values

| Code | Meaning |
|---|---|
| `I` | Immediata |
| `D` | Differita |
| `S` | Scissione dei pagamenti (split payment) |

`S` is the one to get right for public-administration invoicing.

## Virtual stamp duty (`stampDuty`)

For invoices carrying *imposta di bollo virtuale* (e.g. VAT-exempt amounts over €77.47):

```json
"stampDuty": { "virtual": true, "amount": "2.00" }
```

Emitted as `DatiBollo` / `BolloVirtuale = SI` / `ImportoBollo` right after the invoice number. `virtual` must be `true`; `amount` is a non-negative decimal string, rounded half-up to 2 decimals. PASSO transmits it as sent — it does not decide whether stamp duty is due.

## FormatoTrasmissione — 2 values

`FPR12` private (B2B/B2C) · `FPA12` public administration (B2G).

## Enums used by the generator but not yet on the input model

`TipoRitenuta` (`RT01`–`RT06`), `TipoCassa` (`TC01`–`TC22`), `SocioUnico` (`SU`, `SM`), `StatoLiquidazione` (`LS`, `LN`) and `TipoScontoMaggiorazione` (`SC`, `MG`) are generated from the XSD and available in `fatturapa-enums.ts`, but the current `InvoiceSchema` exposes no fields that use them. Withholding tax, professional-fund contributions and line discounts are not part of the input model in this version (virtual stamp duty is: see `stampDuty`).

---

# Money rules

The rules most likely to cost you a rejection.

## Amounts are strings

```json
{ "totalPrice": "1000.00" }    ✅ string
{ "totalPrice": 1000.00 }      ❌ JSON number — 400
```

The schema is `z.string()`. A JSON number is rejected before anything else happens.

The reason is not stylistic. JSON numbers are IEEE-754 doubles, and `0.1 + 0.2 !== 0.3`. Money that has round-tripped through a double is money that has quietly changed, and there is no point in the pipeline where that is recoverable. PASSO parses every amount into a `Decimal` from a string and never touches a float.

**Accepted input pattern** — `/^-?\d{1,11}(\.\d{1,8})?$/`:

| Input | Accepted | Emitted |
|---|---|---|
| `"1000.00"` | yes | `1000.00` |
| `"1000"` | yes | `1000.00` |
| `"1000.5"` | yes | `1000.50` |
| `"1000.123456"` | yes | rounded/padded per field type |
| `1000.00` (number) | **no** | `400` |
| `"1,000.00"` | **no** | `400` |
| `"1000.00 EUR"` | **no** | `400` |

::: tip The trailing `.00` is mandatory in the XML, not in your input
This is a distinction the rest of the docs sometimes compresses. The **FatturaPA XSD** requires `1000.00` and rejects `1000` — `Amount2DecimalType` is `[\-]?[0-9]{1,11}\.[0-9]{2}`.

PASSO's **input** schema is more forgiving: it accepts `"1000"` and pads it to `1000.00` at generation time. What it will never do is accept a JSON *number*.

So: always send `"1000.00"` — it is unambiguous and matches what goes on the wire. But if your CRM emits `"1000"`, that works; it is `1000` without quotes that fails.
:::

## Maximum 11 integer digits

`[0-9]{1,11}` before the decimal point. The largest representable amount is `99999999999.00` — just under 100 billion.

This is checked twice: by the input regex, and again in `toDecimal` at generation with an explicit message. Exceeding it usually means a units error — cents mistaken for units, or a currency stored in minor units.

## `vatRate` is a decimal percent

```json
{ "vatRate": "22.00" }    ✅ 22 percent
{ "vatRate": "0.22" }     ❌ this is 0.22 percent
{ "vatRate": "2200" }     ❌ basis points — schema-invalid
{ "vatRate": 22 }         ❌ a number
```

`RateType` is `[0-9]{1,3}\.[0-9]{2}` with a maximum of `100.00`. `fmtRate` rejects anything outside `0..100`.

Basis points is the most damaging of these, because `"2200"` matches the general decimal pattern and only fails later against `RateType` — an XSD error rather than a clear field message.

## Negatives on amounts, never on quantity or rate

| Field | Negative allowed | Why |
|---|---|---|
| `unitPrice` | yes | Credit notes and adjustments |
| `totalPrice` | yes | Same |
| `taxableAmount` | yes | Same |
| `taxAmount` | yes | Same |
| `payment.amount` | yes | Same |
| **`quantity`** | **no** | `QuantitaType` is unsigned |
| **`vatRate`** | **no** | `RateType` is unsigned |

The model expresses this with two patterns: `decimalString` allows a leading `-`, `nonNegDecimal` does not. `quantity` and `vatRate` use the non-negative one, and `fmtQuantita` rejects a negative again at generation.

A credit note is `TD04` with negative *amounts* and positive quantities — not positive amounts and negative quantities.

## Decimal places by field

| Field | XSD type | Decimals |
|---|---|---|
| `unitPrice` | `Amount8DecimalType` | 2–8; trailing zeros beyond 2 trimmed |
| `totalPrice`, `taxableAmount`, `taxAmount`, `payment.amount` | `Amount2DecimalType` | Exactly 2 |
| `vatRate` | `RateType` | Exactly 2 |
| `quantity` | `QuantitaType` | 2–8 |

`unitPrice` carries 8 decimals for a reason: a unit price of `0.00333333` on 3000 units is a real thing, and rounding it to 2 decimals before multiplying loses money at scale.

Rounding is `ROUND_HALF_UP` at 34 digits of precision throughout.

::: warning `quantity`: 11 digits in, 12 allowed by the XSD
`QuantitaType` permits 12 integer digits, but PASSO's input pattern caps every decimal field at 11. In practice a 12-digit quantity is not a real invoice, but the model is stricter than the schema here.
:::

## Validation order

1. **Zod** — types, patterns, enums, cross-field refinements → `400 ERR_SCHEMA_INVALID` with a `details` array
2. **Signature gate** — B2G on an unsigned channel → `400 ERR_VALIDATION_SIGNATURE_REQUIRED`
3. **Money parsing** — `toDecimal` per field, integer-digit ceiling
4. **XSD** — the generated document against the official schema → `400 ERR_XSD_INVALID`
5. **SdI** — asynchronous; a failure here is an `NS`

Everything through step 4 happens **before** the `202`. Only step 5 is asynchronous.

## Validation error shape

```json
{
  "error": {
    "code": "ERR_SCHEMA_INVALID",
    "message": "Request body failed schema validation",
    "retryable": false,
    "details": [
      { "path": "lines.0.nature", "message": "Natura is required when vatRate is 0" },
      { "path": "seller.taxRegime", "message": "seller.taxRegime (RegimeFiscale) is mandatory" }
    ]
  },
  "requestId": "..."
}
```

`details` carries **every** failure, not the first. Fix them in one pass rather than discovering them one resubmission at a time.
