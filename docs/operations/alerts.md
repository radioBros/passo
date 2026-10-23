# Alerts

Some problems stop invoices without anything visibly breaking: the OpenAPI.it
wallet runs out of credit, a seller was never registered with the vendor, the
PEC mailbox password was changed at the provider. Invoices then sit queued, or
fail, and the reason is only in a log line.

PASSO turns these into **alerts** and sends them by **email** and/or
**webhook**. Both are optional, at two levels:

| Level | Configured with | Receives |
|---|---|---|
| **Operator** | environment variables (`OPERATOR_ALERT_*`) | every alert from every tenant, plus system alerts |
| **Tenant** | `PUT /api/v1/admin/tenants/{tenantId}/alerts` | that tenant's alerts |

With nothing configured, alerts are still recorded and listed by
`GET /api/v1/admin/alerts` — they are just not pushed anywhere.

## Setup

### 1. An SMTP outbox (for email)

A normal mailbox — **not** PEC. One for the whole instance:

```bash
ALERT_SMTP_HOST=smtp.example.com
ALERT_SMTP_PORT=587            # 465 = implicit TLS; anything else requires STARTTLS
ALERT_SMTP_USER=alerts@example.com
ALERT_SMTP_PASSWORD=…
ALERT_FROM="PASSO <alerts@example.com>"
```

TLS is always required and the certificate is always verified; there is no
setting to send alerts, or the SMTP password, in clear.

### 2. Operator destinations (optional)

```bash
OPERATOR_ALERT_EMAIL=ops@example.com,oncall@example.com
OPERATOR_ALERT_WEBHOOK_URL=https://ops.example.com/hooks/passo
OPERATOR_ALERT_WEBHOOK_SECRET=whsec_…   # signs x-passo-signature
```

### 3. Tenant destinations (optional)

```bash
curl -X PUT $PASSO/api/v1/admin/tenants/$TID/alerts \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{ "emails": ["amministrazione@cliente.it"],
        "webhookUrl": "https://crm.cliente.it/hooks/passo-alerts" }'
```

Both fields are optional. Setting a new `webhookUrl` returns a `webhookSecret`
**once** — verify `x-passo-signature` with it exactly as for
[CRM webhooks](/api/webhooks). Re-saving the same URL keeps the secret. If you
save emails while `ALERT_SMTP_HOST` is unset, the response carries a warning:
they are stored but not sent.

### 4. Test it

```bash
curl -X POST $PASSO/api/v1/admin/tenants/$TID/alerts/test \
  -H "authorization: Bearer $ADMIN_KEY"
```

Sends a test alert to the tenant's destinations and the operator's **now**, and
reports each one:

```json
{ "sent": 2, "failed": 1, "results": [
  { "destination": "email", "target": "amministrazione@cliente.it", "ok": true },
  { "destination": "email", "target": "ops@example.com", "ok": true },
  { "destination": "webhook", "target": "https://ops.example.com/hooks/passo",
    "ok": false, "error": "HTTP 404" } ] }
```

## What raises an alert

| Kind | Severity | When | What to do |
|---|---|---|---|
| `channel.credit_exhausted` | critical | The vendor refuses with "out of credit" (OpenAPI.it 402 / error 611) | Top up the wallet. Invoices wait and go out by themselves |
| `channel.setup_required` | critical | The seller has no OpenAPI.it business registry, or `requestSigning` disagrees with `apply_signature` | Register the seller / align the setting, then retry failed invoices |
| `channel.auth_failed` | critical | The vendor rejects the token or key | New credentials, `PUT …/channels/{channel}`, then retry |
| `channel.unreadable` | critical | The stored channel configuration cannot be loaded | Usually an encryption-key change |
| `channel.unavailable` | warning | The vendor is unreachable or failing | Usually nothing — invoices retry |
| `submission.outcome_unknown` | critical | The vendor did not answer in time; the invoice may or may not have arrived | Check the vendor console; retry only if it is not there |
| `submission.failed` | warning | Invoices failed and were not sent | Fix the cause, retry each one |
| `pec.poll_failed` | critical | The PEC mailbox cannot be read | Update the mailbox password |
| `receipt.quarantined` | warning | An SdI message could not be processed | Review `GET /api/v1/admin/quarantine` |
| `webhook.delivery_failed` | warning | The CRM webhook endpoint failed every retry | Fix the endpoint, reconcile via `GET /api/v1/pending` |
| `system.outbox_abandoned` | critical | Work could not be handed to RabbitMQ | Check the broker (operator only) |
| `system.audit_chain_broken` | critical | An audit entry was altered outside PASSO | Treat as a security incident (operator only) |
| `system.ingress_stalled` | critical | Receipts stopped arriving | Check the worker and the mailbox (operator only) |

Every alert carries the impact and the remedy in plain language, so the email
is actionable without opening the logs. Alerts contain no invoice data — only
identifiers — because the operator destination receives every tenant's alerts.

## Not a flood

- **One alert per problem.** A repeat of an open alert increments its
  `occurrences` instead of sending again — 500 invoices refused for lack of
  credit produce one alert, not 500 emails.
- **Reminders** while it persists, at most every `ALERT_REPEAT_MINUTES`
  (default 360).
- **Resolved** messages: when the problem is over — the next successful send
  for channel alerts, the next successful mailbox read for PEC — the alert is
  closed and, if a notification had gone out, an `alert.resolved` follows.

## Webhook payload

```json
{
  "event": "alert.firing",
  "sentAt": "2026-10-02T08:15:00.000Z",
  "alert": {
    "id": "…", "kind": "channel.credit_exhausted", "severity": "critical",
    "status": "firing", "title": "SdI channel account is out of credit",
    "impact": "Invoices are NOT being sent. …", "remedy": "Top up the vendor account …",
    "tenant": { "id": "…", "slug": "acme", "name": "Acme CRM" },
    "channel": "openapi", "occurrences": 37,
    "firstSeenAt": "…", "lastSeenAt": "…",
    "detail": { "latestSubmissionId": "…", "code": "ERR_CHANNEL_CREDIT" }
  }
}
```

`event` is `alert.firing`, `alert.resolved` or `alert.test`, also sent as the
`x-passo-event` header, so an endpoint shared with invoice events can tell them
apart. The same SSRF protection as CRM webhooks applies: the URL is checked when
saved and again when sent, and private addresses are refused.

## Delivery

Alerts are delivered from PostgreSQL by the worker, **not** through RabbitMQ —
a broker outage must itself be able to alert. A failed delivery is retried with
backoff up to 8 times, then marked `failed`; `GET /api/v1/admin/alerts` still
lists the alert either way.
