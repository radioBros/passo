# Errors

Every error PASSO returns comes from one catalogue, `src/shared/errors/catalog.ts`. There is no second list, no hand-copied table in the code, and no endpoint that invents its own shape.

## The envelope

```json
{
  "error": {
    "code": "ERR_NATURA_REQUIRED",
    "message": "Natura is required when vatRate is 0.00",
    "retryable": false,
    "details": []
  },
  "requestId": "b1c3e4f5-8a2d-4c91-bb17-2e6f0a9c3d44"
}
```

| Field | Use |
|---|---|
| `code` | **Branch on this.** Stable across releases. |
| `message` | Human-readable prose. May be reworded; never parse it. |
| `retryable` | Whether a bare retry of the identical request could ever succeed. |
| `details` | Present on validation failures — a per-field breakdown. |
| `requestId` | Correlates your call to the operator's logs. Always present. |

When a `detail` string is supplied the message is `"<catalogue message>: <detail>"`, so a `404` reads `Resource not found: submission` rather than the bare form.

## The catalogue

28 codes.

### Authentication and authorisation

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `ERR_AUTH_MISSING` | 401 | no | No `authorization` header, or not a `Bearer` token |
| `ERR_AUTH_INVALID` | 401 | no | The key does not resolve — wrong key, wrong instance, or a malformed prefix |
| `ERR_AUTH_EXPIRED` | 401 | no | The key's `expires_at` has passed |
| `ERR_AUTH_REVOKED` | 401 | no | The key was revoked. Immediate, no grace period |
| `ERR_AUTH_SCOPE` | 403 | no | Valid key, missing scope. The detail names the required scope |

`ERR_AUTH_INVALID` is also what you get for a key belonging to a **suspended** tenant — the `api_key_auth` view joins on `tenants.status = 'active'`, so suspension makes keys stop resolving rather than producing a distinct code.

`ERR_AUTH_SCOPE` is the only `403` in the catalogue, and it is not an isolation decision: it says the key is legitimately yours but lacks a permission. Cross-tenant access is never a `403` — see below.

### Not found and gone

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `ERR_NOT_FOUND` | 404 | no | The resource does not exist, or is not visible to your tenant |
| `ERR_GONE` | 410 | no | It existed; its payload was purged after reaching a terminal state |

#### 404, not 403, for cross-tenant misses

Requesting another tenant's submission id returns `404`, never `403`.

This is not sloppiness — the comment sits next to the code:

```ts
// 404 not 403: a 403 would confirm the resource exists in another tenant.
ERR_NOT_FOUND: { http: 404, message: 'Resource not found', retryable: false },
```

A `403` distinguishes "this id exists but is not yours" from "this id does not exist". That distinction is an **existence oracle**. Given it, an attacker with any valid key can enumerate valid submission ids across the whole instance, learn roughly how many invoices the system handles, and confirm whether a specific identifier they obtained elsewhere is live here.

`404` says only: not yours, and I will not tell you whether it is anyone's.

Mechanically this falls out of RLS rather than being bolted on. The tenant policy filters the row, the query returns nothing, and the route raises a not-found. There is no branch that *could* leak the distinction, because the query never saw the row.

#### 410 Gone after purge

PASSO is a relay, not an archive. Once a terminal receipt arrives, the payload and generated XML are purged and these endpoints change behaviour:

| Endpoint | Before purge | After purge |
|---|---|---|
| `GET /invoices/{id}/xml` | The XML | `410 ERR_GONE` |
| `GET /invoices/{id}/rendered` | Rendered HTML | `410 ERR_GONE` |
| `GET /invoices/{id}` | Full status | Still works — status survives |
| `GET /invoices/{id}/receipts` | Receipts | Still works until receipts are purged |

```json
{
  "error": {
    "code": "ERR_GONE",
    "message": "Resource was purged after reaching a terminal state: purged after reaching state \"delivered\"",
    "retryable": false
  },
  "requestId": "..."
}
```

The detail names the state it reached, so you know whether it was delivered, rejected or attested.

::: tip Why 410 and not 404
`404` means "I have no idea what you are talking about." `410` means "this existed, it is permanently gone, stop asking." That distinction is actionable: a `410` tells your CRM to reconcile from its own copy rather than to re-poll or raise a data-integrity alarm.

Disclosing "a submission with this id once existed" to a caller who **already owns it** is not a leak. RLS still filters, so a cross-tenant id gets `404`.
:::

**Fetch what you need before purge.** The XML, the rendered HTML and the receipts are available while a submission is in flight and for as long as your retention window allows. See [What PASSO is not](/guide/scope).

### Validation

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `ERR_SCHEMA_INVALID` | 400 | no | Body failed Zod validation. `details` lists every failing path |
| `ERR_RENDER_FAILED` | 422 | no | The document could not be rendered. Most often it declares a `DOCTYPE` or an `ENTITY`, which is **refused**: external entities are an arbitrary-file-read vector, and a FatturaPA document never needs one |
| `ERR_TRANSFORM_FAILED` | 400 | no | The named transformation could not map your payload. `details` carries **both** the source path you sent and the canonical target it failed to produce |
| `ERR_MESSAGE_TOO_LARGE` | 413 | no | The message exceeds SdI's 30 MB hard limit. Attachments travel **inside** the invoice and count against the same limit — over PEC the base64 encoding inflates it further |
| `ERR_VALIDATION_FAILED` | 400 | no | Business validation failed |
| `ERR_NATURA_REQUIRED` | 400 | no | `vatRate` is `0.00` with no `nature` |
| `ERR_VALIDATION_PEC_REQUIRED` | 400 | no | `recipientCode` is `0000000` with no `recipientPec` |
| `ERR_VALIDATION_SIGNATURE_REQUIRED` | 400 | no | B2G on a channel that cannot sign |
| `ERR_XSD_INVALID` | 400 | no | Generated XML failed the official XSD |
| `ERR_XSD_UNAVAILABLE` | **500** | no | The XSD is not bundled — a deployment fault |
| `ERR_XFORM_FAILED` | 422 | no | A transformation rule failed |

`ERR_SCHEMA_INVALID` carries the full breakdown:

```json
{
  "error": {
    "code": "ERR_SCHEMA_INVALID",
    "message": "Request body failed schema validation",
    "retryable": false,
    "details": [
      { "path": "lines.0.vatRate", "message": "must be a non-negative decimal string" },
      { "path": "seller.taxRegime", "message": "seller.taxRegime (RegimeFiscale) is mandatory" }
    ]
  }
}
```

Every failure, not the first. Fix them in one pass.

::: warning `ERR_XSD_UNAVAILABLE` is a 500 and it is your fault, not the caller's
It means `assets/xsd` is missing from the image. Since XSD validation is a mandatory, non-skippable gate, this blocks **every** submission for **every** tenant.

`retryable: false` — retrying will not help. Rebuild the image with `assets/` copied in. See [Deployment](/operations/deployment).
:::

`ERR_XSD_INVALID` is different: PASSO generated a document that the official schema rejected. Since the generator maps from a validated model, this usually means a value that passed Zod but violates an XSD pattern — an out-of-range rate, an over-long field, an amount exceeding 11 integer digits.

`ERR_XFORM_FAILED` is a `422` rather than a `400`: the request was syntactically fine, but the configured transformation could not produce a valid invoice from it.

### Channels

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `ERR_CHANNEL_UNAVAILABLE` | 503 | **yes** | The channel could not be reached |
| `ERR_CHANNEL_TIMEOUT` | 504 | **yes** | The channel did not answer in time |
| `ERR_CHANNEL_AUTH` | 502 | no | The channel rejected PASSO's credentials |
| `ERR_CHANNEL_NOT_CONFIGURED` | 400 | no | No channel is configured for this tenant |
| `ERR_CHANNEL_SETUP` | 502 | no | The channel account is not set up for this seller — on OpenAPI.it, no business registry for its fiscal ID, or `requestSigning` disagreeing with the registry's `apply_signature` |
| `ERR_CHANNEL_CREDIT` | 502 | yes | The channel account is out of credit (OpenAPI.it: HTTP 402, vendor error 611). Nothing was sent; the invoice stays queued and goes through once the account is topped up |
| `ERR_PEC_SIZE_EXCEEDED` | 400 | no | The PEC message including attachment exceeds 30 MB |

The retryability split is the point. `ERR_CHANNEL_UNAVAILABLE` and `ERR_CHANNEL_TIMEOUT` are transient — the vendor is down, the network hiccupped — and the worker reschedules them through the delayed exchange. `ERR_CHANNEL_AUTH` is a `502` marked non-retryable: your credentials are wrong, and retrying wrong credentials five times just produces five failures and possibly a lockout.

`ERR_PEC_SIZE_EXCEEDED` checks the **base64-encoded** size, roughly 33% larger than the raw XML, plus ~8 KB of message overhead. A 23 MB XML file is over the limit once encoded. The check runs before transmission, so you get a clean `400` rather than a bounced mail.

::: warning `ERR_CHANNEL_REJECTED` is not in this catalogue
The Invoicetronic and OpenAPI.it adapters throw a `ChannelError` with the code `ERR_CHANNEL_REJECTED` when a vendor returns a non-retryable 4xx. It is **not** an `ApiError` and never becomes an HTTP response body.

It surfaces in the worker's logs and in the audit log's `submission.failed` detail, and the message dead-letters. If you are matching on error codes from logs rather than from API responses, this one exists there and only there.
:::

### Rate limiting and conflicts

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `ERR_RATE_LIMITED` | 429 | **yes** | 100 requests per 60 s exceeded |
| `ERR_CONFLICT_IDEMPOTENCY` | 409 | no | An idempotency key was reused with a different body |
| `ERR_CONFLICT_NS_RETRY` | 409 | no | Retry refused — the submission was rejected by SdI |
| `ERR_CONFLICT_MC_RETRY` | 409 | no | Retry refused — SdI is still attempting delivery |
| `ERR_CONFLICT_TERMINAL` | 409 | no | Retry refused — already in a terminal state |

`ERR_RATE_LIMITED` comes with a `retry-after` header in seconds. Honour it.

`ERR_CONFLICT_IDEMPOTENCY` means the same key arrived with a different body hash. Either you reused a key by accident, or you changed the payload on a retry — both are bugs worth surfacing rather than papering over.

### Internal

| Code | HTTP | Retryable | Meaning |
|---|---|---|---|
| `ERR_INTERNAL` | 500 | **yes** | Unhandled error |

Anything not an `ApiError` is caught by the error handler, logged with the full stack, and returned as this. The response body deliberately contains nothing but the code, the generic message and the `requestId` — internal detail never reaches the caller.

### Malformed requests

The error handler maps `body-parser` rejections before they can fall through to `ERR_INTERNAL`:

| Code | HTTP | Retryable | Cause |
|---|---|---|---|
| `ERR_PAYLOAD_TOO_LARGE` | 413 | no | Body exceeds the 10 MB parser limit |
| `ERR_UNSUPPORTED_MEDIA_TYPE` | 415 | no | Unsupported or unparseable content encoding |

A malformed JSON body (`entity.parse.failed`) is reported as `400 ERR_SCHEMA_INVALID` with the message `"Malformed request body"`.

::: tip Why these are mapped rather than left to the 500 handler
Unmapped, a body-parser rejection surfaces as `500 ERR_INTERNAL` with `retryable: true`. That tells a CRM to retry a request that can **never** succeed — an oversized invoice would retry forever, on a schedule, at increasing intervals, indefinitely.

A client fault must be reported as a client fault, with `retryable: false`.
:::

---

## The two retry-refusal codes

These deserve their own section, because they are the most common integration mistake and the one with a real financial consequence.

Both come from a single guard, `canRetry(state)`:

```ts
export function canRetry(state: State): { ok: boolean; reason?: string } {
  if (state === STATE.rejected)         return { ok: false, reason: 'ERR_CONFLICT_NS_RETRY' };
  if (state === STATE.awaitingDelivery) return { ok: false, reason: 'ERR_CONFLICT_MC_RETRY' };
  if (TERMINAL.has(state))              return { ok: false, reason: 'ERR_CONFLICT_TERMINAL' };
  return { ok: true };
}
```

That function is the thing standing between an automated retry loop and a duplicate document at the Italian tax authority. Both the HTTP route and the MCP `retry_submission` tool go through it.

### `ERR_CONFLICT_NS_RETRY`

```json
{
  "error": {
    "code": "ERR_CONFLICT_NS_RETRY",
    "message": "Rejected by SdI (NS). NS is terminal — the invoice is legally not issued. Correct it and submit a NEW invoice; PASSO will allocate a new ProgressivoInvio.",
    "retryable": false
  }
}
```

**Why it exists.** An `NS` (`NotificaScarto`) means SdI refused the file. The invoice is **legally not issued** — for tax purposes it does not exist.

Retrying is not merely useless, it is actively harmful:

1. **The same `ProgressivoInvio` is already burned.** SdI has seen it. Resubmitting it yields another rejection, this time for duplication.
2. **The defect is still there.** Nothing about the invoice changed between attempts.
3. **A corrected invoice needs a fresh progressivo**, and only a new submission gets one.

Everything about a normal retry mechanism argues for retrying an `NS`: it is a failure, it came back from an external system, and it is exactly the shape an exponential-backoff loop is built for. Which is why the refusal is explicit and carries a full explanation rather than a bare status code.

**What to do instead:** read the `errors` array — an `NS` carries a **list** of codes, not one — fix every defect, and `POST /invoices` a new invoice. PASSO allocates a new `ProgressivoInvio` automatically.

### `ERR_CONFLICT_MC_RETRY`

```json
{
  "error": {
    "code": "ERR_CONFLICT_MC_RETRY",
    "message": "MC means SdI is still attempting delivery. Resubmitting would duplicate the invoice.",
    "retryable": false
  }
}
```

**Why it exists.** An `MC` (`NotificaMancataConsegna`) is not a failure at all. SdI **accepted** the invoice — it is legally issued — and simply could not deliver it to the recipient yet. A full mailbox, an unreachable endpoint, a dead channel on the other side.

SdI keeps trying on its own, for days.

The trap is that `MC` *reads* like an error. The name contains "Mancata" — failed. It arrives on the same channel as an `NS`. A state machine that groups notifications into success and failure will put it in the wrong bucket, and the retry that follows submits a **second copy of a document that already legally exists**.

PASSO makes the distinction impossible to miss in three places: the state is named `awaiting_delivery`, not `failed`; `/retry` refuses with this code; and the webhook payload states it outright:

```json
{
  "notificationType": "MC",
  "legallyIssued": true,
  "retryable": false,
  "action": "none_required"
}
```

**What to do instead:** nothing. Wait for the `RC`.

### `ERR_CONFLICT_TERMINAL`

The catch-all for the remaining terminal states — `delivered`, `accepted_by_pa`, `rejected_by_pa`, `undelivered_attested`, `failed`. The work is finished, whatever the outcome, and there is nothing to retry.

Note that `failed` is terminal too: it means the submission never reached SdI after exhausting its channel retries. Recovery there is an operator task through the DLQ, not a caller-initiated retry. See [the runbook](/operations/runbook).

### What `/retry` *is* for

Transient failures that have not yet reached a terminal state — a submission in `queued` or `transmitting` that stalled. It re-enqueues the existing submission with its existing `ProgressivoInvio`, which is safe precisely because SdI never accepted it.

---

## SdI rejection codes (NS)

A `NS` is **terminal**: the invoice is legally *not issued*, and fixing it means
submitting a **new** invoice with a new `ProgressivoInvio`. So you must act on
every rejection — and SdI gives you only a bare five-digit code like `00423`.

PASSO ships the complete **63-code catalogue** from the Agenzia delle Entrate
*Elenco dei controlli* v2.0, and enriches every rejection with it.

### In the webhook and the status response

```json
{ "code": "00409",
  "description": "Fattura duplicata nel lotto …",
  "sdiDescription": "Fattura duplicata",
  "gloss": "SdI already holds this invoice",
  "remedy": "duplicate",
  "guidance": "SdI already holds an invoice with this seller, year and number. Do NOT resubmit; …",
  "known": true }
```

`description` is the official Italian text, **verbatim** — it names FatturaPA
elements by their exact path and tag, so translating it would break the
correspondence to the schema. `gloss` is a short English triage aid, never
authoritative. `sdiDescription` is whatever SdI itself sent, kept beside ours.

### The six remedies

| `remedy` | What to do |
|---|---|
| `fix_payload` | A field is wrong. Correct it, issue a **new** invoice |
| `fix_identifiers` | A VAT number, fiscal code or recipient code is wrong |
| `signature` | The signature was rejected — **a CRM cannot fix this**; the signing certificate or service must be corrected |
| `duplicate` | **Do NOT resubmit.** SdI already holds it |
| `split` | The file exceeds the channel size limit |
| `resubmit` | A transport fault. PASSO retries; no CRM action |

::: warning `00409` is the trap
"Duplicate" invites a resubmit, and resubmitting is exactly wrong — SdI already
has the invoice. Either it was accepted (check the original) or you need a
different number.
:::

### Looking codes up

```bash
GET /api/v1/sdi-errors          # all 63, plus the remedy guidance
GET /api/v1/sdi-errors/00409    # one code
```

Published as an endpoint so you can build your own mapping table without
shipping a copy of an Italian-language PDF. Operators can also query the seeded
reference table directly:

```sql
SELECT code, gloss_en, remedy FROM sdi_error_catalog WHERE code = '00409';
```

An **unknown** code — SdI adds them over time — is reported as `known: false`
with SdI's own text preserved, never silently swallowed.

## Handling errors in your CRM

```ts
const res = await fetch(`${PASSO}/api/v1/invoices`, { /* … */ });

if (res.ok) return await res.json();

const { error, requestId } = await res.json();

switch (error.code) {
  // Fix the data. Never retry as-is.
  case 'ERR_SCHEMA_INVALID':
  case 'ERR_VALIDATION_FAILED':
  case 'ERR_NATURA_REQUIRED':
  case 'ERR_VALIDATION_PEC_REQUIRED':
  case 'ERR_VALIDATION_SIGNATURE_REQUIRED':
  case 'ERR_XSD_INVALID':
    throw new InvoiceDataError(error.details, requestId);

  // Back off and retry the same request.
  case 'ERR_RATE_LIMITED':
    return retryAfter(res.headers.get('retry-after'));
  case 'ERR_CHANNEL_UNAVAILABLE':
  case 'ERR_CHANNEL_TIMEOUT':
  case 'ERR_INTERNAL':
    return scheduleRetry({ backoff: true, requestId });

  // Never retry. A corrected NEW invoice is the only path.
  case 'ERR_CONFLICT_NS_RETRY':
    return markRejectedAndRequireNewInvoice(requestId);

  // Do nothing at all. The invoice is issued.
  case 'ERR_CONFLICT_MC_RETRY':
    return markAwaitingDelivery(requestId);

  // Page an operator.
  case 'ERR_CHANNEL_AUTH':
  case 'ERR_CHANNEL_NOT_CONFIGURED':
  case 'ERR_CHANNEL_SETUP':
  case 'ERR_XSD_UNAVAILABLE':
    return alertOperator(error.code, requestId);

  default:
    throw new PassoError(error.code, error.message, requestId);
}
```

The `retryable` flag encodes most of this, so a simpler rule works as a default: retry with backoff when `retryable` is true, surface to a human when it is false. The switch exists because the three conflict codes each need a *different* non-retry action, and collapsing them loses that.

## Log the `requestId`

Whatever else you do, keep it. It is the only handle that ties your failed call to a line in the operator's logs, and it is the first thing an operator will ask for.

Better still, send your own: `x-request-id: crm-job-88213` is echoed back and appears in both systems' logs.
