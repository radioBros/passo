# Notifications and Webhooks

## The nine SdI notification types

Six are addressed to you as transmitter and drive submission state:

| Code | Meaning | Terminal | What to do |
|---|---|---|---|
| **RC** | Delivered to the recipient | ✅ | Nothing — success |
| **NS** | **Rejected by SdI** | ✅ | **Fix and submit a NEW invoice.** Legally not issued |
| **MC** | Not yet delivered; SdI still trying | ❌ | **Nothing.** The invoice IS issued |
| **NE** | The PA's accept/reject decision (B2G) | ✅ | `EC02` is a commercial dispute |
| **DT** | The PA did not respond in time (B2G) | ✅ | Stands as delivered |
| **AT** | Transmission attested; delivery impossible | ✅ | Retain as evidence |

Three — **MT**, **EC**, **SE** — belong to the inbound-reception flow (receiving invoices addressed to you). PASSO recognises and quarantines them rather than failing; inbound reception is v2.

## Webhook payload

```jsonc
{
  "eventId": "uuid",          // dedupe on this: delivery is at-least-once
  "eventType": "invoice.rejected",
  "apiVersion": "v1",
  "timestamp": "2026-09-01T10:00:00.000Z",
  "tenantId": "uuid",
  "data": {
    "submissionId": "uuid",
    "notificationType": "NS",
    "retryable": false,
    "requiresNewSubmission": true,
    "errors": [{ "codice": "00100", "descrizione": "Certificato di firma scaduto" }]
  }
}
```

`errors` is an **array** — one rejection can carry several codes.

## Verifying the signature

`X-Passo-Signature: t=<unix>,v1=<hex>`, an HMAC-SHA256 over `"<t>.<rawBody>"`.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')));
  const { t, v1 } = parts;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;  // replay window

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const received = Buffer.from(v1, 'hex');
  // timingSafeEqual THROWS on unequal lengths — check first, or it crashes
  // instead of returning false.
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
```

Compute over the **raw body bytes**. Re-serialising the parsed JSON changes them and the signature will not match.

## Delivery semantics

At-least-once, with a 6-attempt ladder from 1 s to 1 h. Dedupe on `eventId`. Return 2xx quickly and process asynchronously.

Once the ladder is exhausted the event is **not lost** — it appears in `GET /api/v1/pending`.

## Event catalogue

Also available live as `GET /api/v1/webhook-events` (scope `invoices:read`).

| Event | Terminal | Issued | Action |
|---|---|---|---|
| `invoice.submitted` | no | no | none — queued, not yet at SdI |
| `invoice.transmitted` | no | no | wait for a receipt |
| `invoice.delivered` | yes | yes | nothing (RC or DT) |
| `invoice.rejected` | yes | **no** | **issue a NEW invoice** (NS) |
| `invoice.exception` | no | **yes** | nothing (MC — still delivering) |
| `invoice.transmitted_undelivered` | yes | yes | notify the recipient yourself (AT) |
| `invoice.accepted_by_pa` | yes | yes | nothing (NE/EC01) |
| `invoice.rejected_by_pa` | yes | yes | contact the recipient (NE/EC02 — commercial) |
| `invoice.status_changed` | no | — | inspect status |
| `invoice.timeout` | no | — | inspect status |
| `submission.failed` | yes | no | fix and resubmit — never reached SdI |
| `apikey.expiring` | no | — | rotate the key |
| `apikey.expired` | yes | — | rotate the key |

## Managing subscriptions

A CRM manages its own webhooks with a tenant key. The Admin API `POST /admin/tenants/{id}/webhooks` is the bootstrap equivalent.

### `POST /api/v1/webhooks`

Scope: `webhooks:write`. The signing secret is returned **once**.

```bash
curl -X POST localhost:3000/api/v1/webhooks \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{
    "callbackUrl": "https://crm.example.com/hooks/passo",
    "events": ["invoice.delivered","invoice.rejected","invoice.exception"],
    "description": "production"
  }'
```

`url` is accepted as an alias of `callbackUrl`. Default events: `invoice.delivered`, `invoice.rejected`.

```json
{
  "id": "…",
  "callbackUrl": "https://crm.example.com/hooks/passo",
  "events": ["invoice.delivered", "invoice.rejected", "invoice.exception"],
  "secret": "whsec_…",
  "note": "Store this secret now — it is never shown again.",
  "requestId": "…"
}
```

The URL is SSRF-checked (HTTPS in production, no credentials, no private/loopback/link-local/CGNAT resolution). The same check runs again at every delivery.

`400` for an unknown event name or a blocked URL.

### `GET /api/v1/webhooks`

Scope: `webhooks:read`. Secrets are never returned — only `secret_prefix`.

### `PATCH /api/v1/webhooks/{id}`

Scope: `webhooks:write`. Any of `callbackUrl`, `events`, `description`, `active`. Re-enabling (`active: true`) clears the consecutive-failure counter.

### `DELETE /api/v1/webhooks/{id}`

Scope: `webhooks:write`. `204`.

### `POST /api/v1/webhooks/{id}/rotate-secret`

Scope: `webhooks:write`. Both the old and the new secret sign every delivery during the overlap (default 24 h, max 168). Parse **every** `v1=` in the header, not just the last.

```json
{
  "id": "…",
  "secret": "whsec_…",
  "overlapHours": 24,
  "note": "Both signatures are sent for 24h. Deploy this secret before the window closes.",
  "requestId": "…"
}
```

### `GET /api/v1/webhooks/{id}/deliveries`

Scope: `webhooks:read`. The self-service debugging surface.

| Query | Notes |
|---|---|
| `eventType` | Filter |
| `status` | `delivered` or `failed` |
| `limit` | Default 50, cap 200 |
| `before` | Cursor — previous page's `nextCursor` |

```json
{
  "data": [
    {
      "id": "…", "event_id": "…", "event_type": "invoice.rejected",
      "submission_id": "…", "attempt": 3, "http_status": 503,
      "error": "…", "delivered_at": null, "next_retry_at": "…", "created_at": "…"
    }
  ],
  "nextCursor": "2026-09-01T10:00:00.000Z",
  "requestId": "…"
}
```

## Vendor inbound callback

`POST /api/v1/inbound/{token}` is where OpenAPI.it (and Invoicetronic) push receipts. Authenticated by the per-tenant token in the path — vendor consoles often cannot send custom headers.

PASSO treats the callback as a **hint**: it re-reads the receipt from the vendor with the tenant's own token, so a forged callback cannot change state.

Always `200` for a duplicate or a quarantine, so the vendor stops retrying. `401` unknown token. `400` unparseable (the body is never echoed). `413` over the inbound size limit, refused before parsing.

## Catalogues

| Method | Path | Returns |
|---|---|---|
| GET | `/api/v1/webhook-events` | The table above, with `terminal` / `legallyIssued` / `action` |
| GET | `/api/v1/scopes` | The eight API-key scopes and the defaults |
| GET | `/api/v1/sdi-errors` | The 63 AdE rejection codes, descriptions, remedies |
| GET | `/api/v1/sdi-errors/{code}` | One code, enriched |
