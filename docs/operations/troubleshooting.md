# Troubleshooting

The failures integrators actually hit, in rough order of frequency.

## "My invoice was rejected — I retried and now it's rejected twice"

**NS is terminal.** The invoice was never issued; retrying submits the same
document again and it fails the same check. `/retry` refuses with `409` for
exactly this reason.

Read the `errors` array — each entry carries a `description`, a `remedy` and
`guidance` — fix the field, and submit a **new** invoice.

## "SdI says duplicate (00409)"

You submitted the same seller + year + number twice. Resubmitting again will not
help. Either the original was accepted (check
`GET /api/v1/invoices?status=delivered`) or you need a different number.

The usual cause is retrying a submission without an idempotency key.

## "I got MC and treated it as a failure"

The invoice **is** legally issued. SdI simply cannot reach the recipient yet and
is still trying. Resubmitting produces `00409`. See
[Submission lifecycle](/guide/lifecycle).

## "Invalid CodiceDestinatario"

| Recipient | `recipientCode` | Also required |
|---|---|---|
| Private (B2B/B2C), has a code | 7 characters | — |
| Private, PEC only | `0000000` | `recipientPec` |
| Public administration | **6** characters (IPA) | `format: "FPA12"` |

A 7-character code with `FPA12`, or 6 with `FPR12`, is rejected as `00427`.

## "My B2G invoice was rejected"

A PA invoice almost always needs **CIG** or **CUP** — and they live inside
`DatiOrdineAcquisto`, not at the top level. Set `cig` / `cup` and, if the
invoice is against a contract or convention, `contractId` / `conventionId`.

## "Amounts are wrong by 100× or 10,000×"

Money is a **string with exactly two decimals**: `"1000.00"`, never `1000`.

If your CRM stores integer cents, the transformation needs `divide(100)` —
`multiply(100)` produces a plausible number that is wrong by 10,000×. Use the
dry-run endpoint and read the trace:

```bash
POST /api/v1/transformations/test
→ "steps": [ { "fn": "divide", "arg": 100, "in": 100000, "out": "1000" }, … ]
```

## "The webhook signature never verifies"

Almost always because the body was re-serialised. Verify over the **raw bytes**
before `JSON.parse` — see [Integration modes](/guide/integration-modes).

Second most common: the header carries two `v1=` values during a secret
rotation, and a receiver that parses it into a map keeps only the last.

## "My webhook stopped arriving"

1. `GET /api/v1/webhooks` — is it `active`? Check `disabled_reason` and
   `consecutive_failures`.
2. `GET /api/v1/webhooks/{id}/deliveries?status=failed` — the attempt history,
   the HTTP status we got, and the error.
3. Is your callback still resolving to a **public** address? A URL that starts
   resolving to a private range is blocked at delivery, not only at registration.

## "PEC receipts stopped arriving"

Check the worker log for `INGRESS STALLED`. That message means the poller has
not completed a cycle — a PASSO-side failure, distinct from SdI being slow.

The other silent case: SdI assigns a **dedicated PEC address** in its first
reply. If that was never recorded, later submissions keep going to `sdi01@`,
where delivery is explicitly not guaranteed. Check
`GET /api/v1/admin/tenants/{id}/channels` for `pec_sdi_address`.

## "I get 403 and don't know why"

The message names the missing scope:

```json
{ "error": { "code": "ERR_AUTH_SCOPE",
             "message": "API key lacks the required scope: webhooks:write" } }
```

`GET /api/v1/scopes` lists them all. Note that **read does not imply write** and
write does not imply read.

## "410 Gone on an invoice I know exists"

It existed and was purged. PASSO keeps **no archive**: once a terminal receipt
arrives the payload is destroyed.

Fetch `GET /api/v1/invoices/{id}/export` **before** that happens — it returns
the XML, the rendering, the receipts and verifiable hashes in one call. There is
no recovery path afterwards, by design.

## "Retries seem instant"

The RabbitMQ delayed-message plugin is missing. PASSO refuses to boot without it
precisely because retries would become immediate redelivery — a hot loop against
the tax authority. If you see `PASSO_BOOT_REFUSED`, build the broker from
`docker/rabbitmq/Dockerfile`.

## "Submissions sit in `queued` forever"

1. Is the relay running? `docker compose ps relay`
2. `SELECT count(*) FROM outbox WHERE published_at IS NULL;`
3. Check the relay log for `ABANDONED` — a row the broker refuses is dropped
   after 20 attempts so it cannot block everything behind it, and the log line
   carries what is needed to recover it.
