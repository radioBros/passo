# Submitting Invoices

## `POST /api/v1/invoices`

Async by default. Returns **202 Accepted** once the invoice is durably stored and queued.

```jsonc
{
  "sellerId": "uuid",
  "crmInvoiceRef": "your-own-reference",   // opaque to PASSO, echoed back
  "mode": "async",                          // or "sync"
  "invoice": {
    "documentType": "TD01",
    "number": "2026/0042",
    "date": "2026-09-01",                   // a DATE, not a datetime
    "currency": "EUR",
    "format": "FPR12",                      // FPR12 private · FPA12 public administration
    "recipientCode": "ABC1234",             // 7 chars private · 6 chars PA (IPA)
    "seller": {
      "vatId": { "country": "IT", "code": "01234567890" },
      "name": "Fornitore S.r.l.",
      "taxRegime": "RF01",
      "address": { "street": "Via Roma", "postalCode": "20100",
                   "city": "Milano", "province": "MI", "country": "IT" }
    },
    "buyer": { "...": "same shape; vatId or taxCode" },
    "lines": [{
      "lineNumber": 1, "description": "Consulenza",
      "quantity": "10.00", "unitPrice": "100.00",
      "totalPrice": "1000.00", "vatRate": "22.00"
    }],
    "summaries": [{
      "vatRate": "22.00", "taxableAmount": "1000.00",
      "taxAmount": "220.00", "vatCollectability": "I"
    }]
  }
}
```

### Field rules worth knowing

**`vatId` is split.** `country` and `code` are separate. The `IT` prefix belongs in `country` and must never appear inside `code`.

**Money is a decimal string with a mandatory decimal part.** `"1000.00"` is valid; `"1000"` is not. FatturaPA amounts match `[\-]?[0-9]{1,11}\.[0-9]{2}` — max 11 integer digits. Negative values are allowed on amounts (credit notes) but not on quantity or rate.

**`vatRate` is a decimal percent.** `"22.00"`, never `22` and never basis points.

**Zero-rate lines need `Natura`.** If `vatRate` is `"0.00"`, supply `nature` (`N1`–`N7`, including sub-codes such as `N3.2`). Conversely `nature` is only valid when the rate is zero.

**PA invoices** use `format: "FPA12"` with a 6-character IPA `recipientCode`, and generally require `cig` / `cup`.

**Unknown recipient**: `recipientCode: "0000000"` requires `recipientPec`.

### Sync mode

`"mode": "sync"` waits for the **transmitted (AT) milestone only**, capped at 120 s.

It never waits for final delivery. MC delivery retry runs for days and DT is a ~15-day window, so no HTTP timeout can represent them. On timeout you get **202** and the job continues untouched.

### Idempotency

Send `Idempotency-Key`. The same key with the same body replays the original response; the same key with a **different** body returns `409`.

## `GET /api/v1/invoices/{id}`

```json
{
  "submissionId": "...",
  "status": "delivered",
  "progressivoInvio": "0002P",
  "fileName": "IT01234567890_0002P.xml",
  "channel": "openapi",
  "channelRef": "01a0f93a-b70f-78bf-9b9b-9ab0693a69d2",
  "identificativoSdI": "12345",
  "notifications": [
    { "type": "AT", "received_at": "..." },
    { "type": "RC", "received_at": "..." }
  ]
}
```

`channelRef` is the vendor's own reference for the submission — on OpenAPI.it, its invoice uuid. Quote it to the vendor's support. It is `null` for PEC.

The status also carries `nextAction`, `terminal`, `legallyIssued` and `guidance`, derived from the state machine — so a CRM that polls instead of listening for webhooks does not have to re-implement NS / MC.

::: tip OpenAPI.it names the file itself
`fileName` and `progressivoInvio` are what PASSO generated. OpenAPI.it transmits under its **own** file name (its transmitter ID and sequence), so receipts and the SdI portal show that name, not `fileName`. Correlate by `channelRef` or `identificativoSdI`.
:::

## `POST /api/v1/invoices/{id}/retry`

Retries transient failures only. **Refuses** an NS-rejected submission (`409 ERR_CONFLICT_NS_RETRY`) and an MC (`409 ERR_CONFLICT_MC_RETRY`) — both would duplicate against the tax authority.

## `GET /api/v1/invoices`

Cursor-paginated list of **this tenant's** submissions. Tenant scoping is RLS, not a `WHERE` the handler adds.

| Query | Default | Notes |
|---|---|---|
| `status` | — | Submission state (`queued`, `delivered`, `rejected`, …) |
| `sellerId` | — | UUID of a seller |
| `documentType` | — | e.g. `TD01` |
| `from` / `to` | — | ISO timestamps on `created_at` |
| `limit` | `50` | Capped at 200 |
| `cursor` | — | Opaque `nextCursor` from the previous page (`created_at` plus `id`) |

Cursor, not offset: an offset drifts under concurrent inserts, and a skipped invoice is an unreconciled tax document.

```json
{
  "data": [
    {
      "id": "…", "state": "delivered", "progressivo_invio": "0002P",
      "xml_filename": "IT01234567890_0002P.xml", "channel": "openapi",
      "identificativo_sdi": "12345", "invoice_number": "2026/0042",
      "document_type": "TD01", "seller_id": "…", "created_at": "…"
    }
  ],
  "nextCursor": "2026-09-01T10:00:00.000Z|8f2a…",
  "requestId": "…"
}
```

`nextCursor` is `null` when the page was not full.

## `GET /api/v1/invoices/{id}/xml`

The transmitted FatturaPA XML. `Content-Type: application/xml`.

`410 Gone` after purge — the submission existed; the payload is gone. Fetch before the terminal receipt, or use `GET /export`.

## `GET /api/v1/invoices/{id}/rendered`

HTML via the official AdE stylesheet (`FPR12` or `FPA12`, chosen from the document). `410` after purge.

## `GET /api/v1/invoices/{id}/receipts`

Every SdI notification applied to this submission, oldest first.

```json
{
  "data": [
    { "type": "AT", "received_at": "…", "acknowledged_at": null, "parsed": { } },
    { "type": "RC", "received_at": "…", "acknowledged_at": null, "parsed": { } }
  ],
  "requestId": "…"
}
```

## `GET /api/v1/invoices/{id}/export`

The pre-purge package: XML, SHA-256 over the **plaintext** bytes, official rendering, receipts, transmission metadata. Take this before the terminal receipt. `410` afterwards, with no recovery path.

See [Privacy and export](/api/privacy).

## `POST /api/v1/invoices/{id}/ack`

Acknowledges every unacknowledged receipt on the submission. That is what makes them purge-eligible, after `RECEIPT_ACK_GRACE_DAYS`.

```json
{ "acknowledged": 2, "requestId": "…" }
```

A replay is a no-op (`acknowledged: 0`) and is not re-audited. Scope `invoices:write`.

## `GET /api/v1/pending`

Everything not yet acknowledged: unacknowledged receipts **or** submissions that have not reached a terminal state. Capped at 200, newest first.

This is the safety net. If your endpoint was down and the webhook ladder exhausted, poll here and reconcile — nothing is silently lost. Receipts on this list are never purged.

```json
{
  "data": [
    {
      "submission_id": "…", "crm_invoice_ref": "SO-2026-0042",
      "status": "delivered", "unacknowledged": 1, "created_at": "…"
    }
  ],
  "requestId": "…"
}
```

## `POST /api/v1/render`

Render arbitrary FatturaPA or notification XML with the official stylesheet — so a CRM can still display an invoice PASSO has already purged. Body is raw XML (`Content-Type: application/xml`). Query `?type=` selects the notification stylesheet (`RC`, `NS`, …) when the body is a receipt.

Scope-guarded (`invoices:read`): it is an XSLT transform on caller-supplied input. Bound by `PASSO_MAX_RENDER_BYTES`.
