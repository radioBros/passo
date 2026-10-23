# Integration modes

Two ways to learn what happened to an invoice. **Async is the recommended
default**; sync exists for CRMs that cannot receive an inbound HTTP call.

## Async (recommended)

```
POST /api/v1/invoices            → 202 { submissionId, trackingUrl }
        ↓  (minutes to days)
POST https://your-crm/hooks      ← invoice.transmitted
POST https://your-crm/hooks      ← invoice.delivered | invoice.rejected | …
```

1. **Register a webhook** — [Webhooks](/api/webhooks).
2. **Submit.** You get `202` and a `submissionId` immediately.
3. **Handle each event.** Verify the signature *before parsing*, then act on
   `eventType`.

### Verify over the RAW BYTES, before parsing

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

app.post('/hooks', express.raw({ type: '*/*' }), (req, res) => {
  const raw = req.body                       // Buffer — NOT re-serialised JSON
  const header = req.get('x-passo-signature')
  if (!verify(raw, header, process.env.WEBHOOK_SECRET)) return res.sendStatus(401)
  const event = JSON.parse(raw.toString('utf8'))
  // …
  res.sendStatus(200)                        // 2xx or PASSO retries
})
```

::: danger Re-serialising the body breaks the signature
`JSON.parse` then `JSON.stringify` produces different bytes — key order,
whitespace, number formatting. The signature covers the bytes we sent, so
verification must run on those exact bytes. This is the single most common
webhook integration bug.
:::

The header can carry **more than one** `v1=` during a secret rotation. Collect
every `v1` and accept if any matches — parsing the header into a map keeps only
the last one, and one of the two secrets then always fails.

## Sync

For a CRM behind a firewall with no inbound HTTP:

```json
POST /api/v1/invoices
{ "sellerId": "…", "invoice": { … }, "mode": "sync", "syncTimeoutMs": 60000 }
```

The connection is held until the invoice reaches SdI, then returns `200` with
`status: "transmitted"`.

**Its limits, stated plainly:**

- It waits for **AT only** — never RC, MC or DT. MC retry runs for days.
- On timeout you get a `202`. The job is untouched and continues.
- Each waiter holds an HTTP connection **and** a Redis subscriber. Past **25
  concurrent waiters per tenant** PASSO returns `202` with
  `x-passo-sync-declined` rather than exhausting the pool for everyone.
- **NS is represented poorly here.** A rejection usually arrives after the
  response has closed, so a sync caller still needs to poll `trackingUrl` or
  register a webhook to learn about it.

Sync is a compatibility affordance. If you can receive a webhook, do.

## Idempotency

Submission is the one call worth retrying blindly, so it takes an idempotency
key:

```bash
curl -X POST /api/v1/invoices \
  -H 'idempotency-key: crm-invoice-2026-0042' \
  -d '{ … }'
```

| Situation | Result |
|---|---|
| Same key, same body | The **original** response. No second invoice. |
| Same key, different body | `409` — the key is bound to its request |
| No key, retried | A **second invoice**, with a second `ProgressivoInvio` |

Use your own invoice identifier as the key. Keys expire after
`IDEMPOTENCY_RETENTION_DAYS` (default 7), which must exceed your retry budget.

### What is safe to retry

| Call | Safe? |
|---|---|
| `POST /invoices` with an idempotency key | **Yes** |
| `POST /invoices` without one | **No** — creates a duplicate |
| `GET` anything | Yes |
| `POST /invoices/{id}/retry` after **NS** | **Refused** — `409`, terminal |
| `POST /invoices/{id}/retry` after **MC** | **Refused** — still delivering |
| `POST /invoices/{id}/ack` | Yes — a replay is a no-op |

A `5xx` or a timeout means **unknown**, not failed. Retry with the same
idempotency key; without one, check `GET /api/v1/invoices?cursor=…` before
resubmitting.
