# SdI Channels

Configured per tenant. Switching channel is a configuration change, not a code change.

| Channel | Cost | Signing | Receipts | Notes |
|---|---|---|---|---|
| **PEC** | your PEC subscription | ❌ none | IMAP polling | Zero marginal cost |
| **OpenAPI.it** | per vendor | ✅ server-side, when `requestSigning` is on | webhook | **Supported.** Use it for B2G |
| **Invoicetronic** | per vendor | ✅ server-side | webhook | ⏸ **Deferred** — adapter included, not yet proven end to end |
| **Mock** | free | ✅ simulated | simulated | Development and tests |

Pricing is between you and the vendor. PASSO ships the connector.

## PEC — two things that will bite

**The SdI address rotates.** Your first submission goes to `sdi01@pec.fatturapa.it`. SdI then replies with a **per-transmitter address** (`sdi02@`, `sdi56@`, …) that all later submissions must use:

> *"L'utilizzo di un indirizzo di PEC diverso da quello assegnato dal SdI non garantisce il buon fine della ricezione del file FatturaPA."*

Continuing to use `sdi01@` raises **no error** — delivery is merely "not guaranteed". PASSO learns the assigned address from SdI's first reply and stores it automatically. Do not hardcode it.

**30 MB hard limit**, message including attachment. PASSO checks the base64-encoded size (~33 % larger than the raw XML) before queueing.

**PEC cannot sign**, and PASSO does not yet accept a pre-signed `.p7m`. So PEC carries **B2B only**: a B2G invoice over PEC is rejected at validation rather than transmitted unsigned to a PA. Send B2G through OpenAPI.it.

## Signature

PASSO never holds a qualified certificate. For B2G, use OpenAPI.it with **`"requestSigning": true`** in the channel configuration, so the vendor signs on your behalf.

Signing is checked against the configuration, not just the channel: OpenAPI.it with signing **off** rejects a B2G invoice with `ERR_VALIDATION_SIGNATURE_REQUIRED`, at submission and again just before transmission. Uploading your own pre-signed `.p7m` is **not supported yet**.

## Choosing a channel

| | **PEC** | **OpenAPI.it** | **Mock** |
|---|---|---|---|
| Cost | Your existing PEC mailbox | Per-invoice or subscription | Free |
| Receipts arrive by | PASSO **polls** IMAP | The vendor **pushes** a webhook | Immediately, in-process |
| Credential | Mailbox **password** | Revocable API key / OAuth | None |
| Signing | None — B2B only | Vendor signs when `requestSigning` is on | n/a |
| Use for | B2B at lowest cost, full control | B2G, or no mailbox to run | Development and CI |

## PEC

You need an accredited PEC mailbox. PASSO sends the invoice as an attachment and
polls the same mailbox for receipts.

```bash
curl -X PUT $PASSO/api/v1/admin/tenants/$TID/channels/pec \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{ "smtpHost": "smtps.pec.example", "smtpPort": 465,
        "imapHost": "imaps.pec.example", "imapPort": 993,
        "user": "azienda@pec.example", "password": "…" }'
```

::: danger A PEC credential is a password, not an API token
It grants **full mailbox access** — including every legal receipt — and the
ability to send as your company. PASSO **cannot revoke it**: containment
requires you to change it at your provider. Treat a leak as an incident there,
not here.
:::

**SdI assigns a dedicated address in its first reply.** Until then PASSO sends
to the first-contact address, where delivery is explicitly *not guaranteed*.
PASSO learns the assigned address automatically and records it; check it with
`GET /api/v1/admin/tenants/{id}/channels` (`pec_sdi_address`).

Receipts arrive on a poll cycle, so expect minutes of latency, not seconds. A
poller that stops is reported as `INGRESS STALLED` — see
[Troubleshooting](/operations/troubleshooting).

### Testing PEC without transmitting

SdI has no test environment over PEC — whatever reaches `sdi01@pec.fatturapa.it`
is a real transmission. Inspect the message instead:

```bash
# the exact email PASSO would send, as an .eml — no network
node --experimental-strip-types scripts/pec-preview.mjs --out invoice.eml

# or send it to your OWN mailbox through your PEC provider
PEC_SMTP_HOST=smtps.pec.example.it PEC_USER=you@pec.example.it PEC_PASSWORD=… \
node --experimental-strip-types scripts/pec-preview.mjs --send --to you@pec.example.it
```

It builds the message with the same function the PEC channel transmits with,
checks the attachment name, size and XSD validity, and refuses any
`fatturapa.it` recipient. What arrives in your mailbox is wrapped in your
provider's signed PEC envelope; PASSO's message is the inner `postacert.eml`.

## Invoicetronic

::: warning Deferred
The Invoicetronic adapter is included and matches the vendor's published contract, but it has **not** been proven end to end against a real account. It is not a supported channel for now — use OpenAPI.it.
:::

An accredited intermediary. Verified against its published documentation and by
probing the live API on 2026-09-02.

```bash
curl -X PUT $PASSO/api/v1/admin/tenants/$TID/channels/invoicetronic \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{ "apiKey": "ik_test_…", "requestSigning": true }'
```

| | |
|---|---|
| Base URL | `https://api.invoicetronic.com/v1` |
| Auth | HTTP **Basic** — the API key is the username, password **empty** |
| Send | `POST /send/file`, multipart, field named `file` |
| Signing | `?signature=Apply` — a query parameter, not a header |
| Receipts | `GET /update?send_id=…` (`state`: 2 sent, 5 delivered, 7 rejected) |
| Errors | RFC 9110 `problem+json` with `title` and `detail` |

::: danger The KEY selects the environment — there is no separate host
`ik_test_…` is the sandbox; `ik_live_…` is production, on the **same** base URL.
A live key in a staging config transmits real invoices to SdI, and the only
remedy is a credit note for a document that was never meant to exist.

PASSO refuses an `ik_live_` key when `NODE_ENV` is not `production`.
:::

## OpenAPI.it

An accredited intermediary — and the supported channel for B2G. **Proven end to
end against the sandbox on 2026-10-01**: PASSO-generated B2B and B2G invoices
accepted, a B2G invoice signed by the vendor, receipts read back and applied.

### Setup, in this order

**1. Register each seller on OpenAPI.it.** Every call for a seller without a
*business registry* fails with error 661 — reported by the vendor as a `401`,
which PASSO turns into `ERR_CHANNEL_SETUP` rather than a credential error. Do it
once per seller VAT number, in the OpenAPI.it console or by API:

```bash
curl -X POST https://test.sdi.openapi.it/business_registry_configurations \
  -H "authorization: Bearer $OPENAPI_TOKEN" -H 'content-type: application/json' \
  -d '{ "fiscal_id": "12345678903", "name": "Fornitore S.r.l.",
        "email": "amministrazione@fornitore.it",
        "apply_signature": true, "apply_legal_storage": false }'
```

`fiscal_id` is the VAT number **without** the `IT` prefix.

**2. Configure the channel in PASSO, with `requestSigning` matching
`apply_signature`.** Signing is a property of the seller's registry: with
`apply_signature: true` OpenAPI.it accepts only signed submissions, with `false`
only unsigned ones (error 387 otherwise). For B2G you need `true` on both sides.

```bash
curl -X PUT $PASSO/api/v1/admin/tenants/$TID/channels/openapi \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{ "token": "…", "baseUrl": "https://test.sdi.openapi.it", "requestSigning": true }'
```

**3. Register the callback** (below) — or rely on polling.

::: tip Receipts arrive even without a public URL
PASSO also **polls** OpenAPI.it for receipts of invoices still waiting on SdI,
every `VENDOR_POLL_INTERVAL_MS` (default 5 minutes). A missed or unreachable
webhook therefore delays a receipt instead of losing it. The polling call that
decides whether anything is new is not billed; the invoice record (for SdI's
own id) is read once per invoice.
:::

::: warning Your OpenAPI.it wallet must have credit
Submitting and reading invoice records are billed. With an empty wallet the
vendor answers `402`; PASSO keeps the invoice queued and retries rather than
failing it, and logs that the account is likely out of credit.
:::

::: info OpenAPI.it names the file it sends
SdI sees the vendor's file name (its transmitter ID and sequence), not PASSO's
`fileName`. Track OpenAPI.it submissions by `channelRef` (the vendor's invoice
uuid) or `identificativoSdI`, both on `GET /api/v1/invoices/{id}`.
:::

| | |
|---|---|
| Production | `https://sdi.openapi.it` — note **`.it`**; `.com` is the console |
| Sandbox | `https://test.sdi.openapi.it` — a **different host** |
| Auth | `Authorization: Bearer <token>` (OAuth-issued, scoped) |
| Send | `POST /invoices` · `/invoices_signature` · `/invoices_legal_storage` · `/invoices_signature_legal_storage` |
| Receipts | `GET /invoices_notifications/{uuid}` — genuine SdI XML with `Accept: application/xml` |
| Callbacks | `POST /api_configurations` — subscribe to `customer-notification` |
| Rate limit | 10,000 requests/minute (production) |

::: warning Every response is an envelope, and it overrides the status code
```json
{ "success": false, "message": "Wrong Token", "error": 125.22, "data": null }
```
`success: false` can arrive with a `200`. PASSO treats the envelope as
authoritative — trusting the status alone would record a refused submission as
accepted, leaving a CRM believing an invoice reached SdI when it never did.

`error` is a **number**, sometimes fractional. On success the handle is
`data.uuid`.
:::

::: danger The default host is PRODUCTION
Omitting `baseUrl` targets `sdi.openapi.it`. PASSO refuses that outside
production and asks for the sandbox host explicitly.
:::

### Setting up the callback

OpenAPI.it pushes receipts to the inbound URL PASSO issues when you configure
the channel. Register it with `POST /api_configurations` for the
`customer-notification` event (every call overwrites the previous
configuration). PASSO treats a callback only as a **hint**: it re-reads the
receipts from OpenAPI.it with the tenant's own token, so a forged callback
cannot change an invoice's state.

The response carries an **inbound webhook URL**, shown once:

```json
{ "channel": "invoicetronic", "configured": true,
  "inboundWebhookUrl": "https://your-passo/api/v1/inbound/pwh_…" }
```

Paste that into the vendor console as the notification callback. It is
authenticated by the token in the path — the token is hashed at rest, scoped to
one tenant and one channel, and re-issued whenever you reconfigure the channel.

::: warning The endpoint must be publicly reachable
It is how receipts get in. Expose `/api/v1/inbound/` and nothing else — in
particular, do not expose `/api/v1/admin/`. See
[Deployment](/operations/deployment).
:::

::: tip Verified in the sandbox — run it yourself before production
`scripts/sandbox-e2e.mjs` drives a running PASSO against the OpenAPI.it sandbox:
submit, simulate an SdI receipt, and check the status PASSO reports. It refuses
any host but `test.sdi.openapi.it`. The production path has not been exercised.
:::

## Mock

For development and CI. It accepts any invoice, returns a synthetic
`IdentificativoSdI`, and reaches SdI never.

```bash
curl -X PUT $PASSO/api/v1/admin/tenants/$TID/channels/mock \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' -d '{}'
```

Every integration test in this repository runs against it, which is what makes
the suite offline and deterministic. It issues no inbound webhook token — there
is no vendor to call back.

::: danger Never configure mock in production
An invoice submitted to the mock channel reaches nothing. It will look
transmitted and will never be issued.
:::
