# Admin API

Provisioning and operations. Everything `passo-cli` does is a call to one of these endpoints — the CLI holds no logic of its own.

PASSO is API-only. There is no admin web UI, in this version or any later one.

## Authentication

Every route under `/api/v1/admin` requires `PASSO_ADMIN_KEY` as a bearer token:

```bash
export ADMIN="your-PASSO_ADMIN_KEY"
curl localhost:3000/api/v1/admin/tenants -H "authorization: Bearer $ADMIN"
```

The key comes from the environment, is compared with `timingSafeEqual` after an explicit length check, and is never stored in the database. PASSO **refuses to start** without it — no default is generated, because a generated secret ends up in shell history and log files.

Minimum length is 24 characters:

```bash
openssl rand -base64 32
```

::: danger The admin key is instance-wide
It grants access to every tenant. It cannot be rotated through the API, scoped, or given a grace period — rotating it means changing the environment variable and restarting.

Never issue it to an integrator. A CRM gets a tenant API key. The admin key belongs to whoever operates the deployment.
:::

Admin authentication also satisfies every scope check on tenant routes (`requireScope` returns early when `req.isAdmin` is set).

## Credentials in responses

| Returned once, at creation | Never returned |
|---|---|
| API key plaintext (`passo_live_…`) | `api_keys.key_hash` |
| Webhook secret (`whsec_…`) | Channel credentials (encrypted config) |
| | The admin key itself |

Two things are handed back exactly once and are unrecoverable afterwards: an API key and a webhook secret. Everything else is either a hash or ciphertext, and no read endpoint exposes either.

`GET /channels` reports *which* channel is active and whether it is configured — never the credentials themselves.

---

## Tenants

### `POST /api/v1/admin/tenants`

```bash
curl -X POST localhost:3000/api/v1/admin/tenants \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{
    "name": "Acme CRM",
    "slug": "acme",
    "transmitterCode": "01234567890",
    "transmitterCountry": "IT"
  }'
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Display name |
| `slug` | yes | Unique across the instance |
| `transmitterCode` | yes | `IdCodice` of the transmitting party |
| `transmitterCountry` | no | `IdPaese`, defaults to `IT` |

```json
{ "id": "7a3f...", "requestId": "..." }
```
`201 Created`.

The transmitter identity is set here and used for every submission this tenant makes. `transmitterCountry || transmitterCode` forms the `transmitter_id` that keys `ProgressivoInvio` allocation — so it is not a cosmetic field.

### `GET /api/v1/admin/tenants`

```bash
curl localhost:3000/api/v1/admin/tenants -H "authorization: Bearer $ADMIN"
```

```json
{
  "data": [
    { "id": "7a3f...", "name": "Acme CRM", "slug": "acme", "status": "active",
      "transmitter_country": "IT", "transmitter_code": "01234567890",
      "created_at": "2026-09-01T09:00:00.000Z" }
  ],
  "requestId": "..."
}
```

`status` is one of `active`, `suspended`, `deactivated` (a CHECK constraint). Only `active` tenants' API keys resolve — the `api_key_auth` view joins on it, so suspension takes effect at the database layer rather than in an application branch.

There is no `PATCH` or `DELETE` for tenants. Status changes are a direct database operation.

---

## API keys

### `POST /api/v1/admin/tenants/{tenantId}/api-keys`

```bash
curl -X POST localhost:3000/api/v1/admin/tenants/$TENANT/api-keys \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"production","environment":"live","expiresInDays":365}'
```

| Field | Default | Notes |
|---|---|---|
| `name` | `"default"` | For your own bookkeeping |
| `environment` | `"live"` | `live` or `test` — becomes part of the key prefix |
| `expiresInDays` | none | Omit for a non-expiring key |

```json
{
  "id": "c4e1...",
  "key": "passo_live_kJ8xN2pQ7vR3mT9wL5yH1bF6",
  "prefix": "passo_live_kJ8x",
  "expiresAt": "2027-09-01T09:00:00.000Z",
  "warning": "store this key now — it cannot be retrieved later"
}
```

::: danger The plaintext appears exactly once
It is bcrypt-hashed (cost 12) before storage. There is no endpoint that returns it and no recovery path. Capture it from this response or rotate.
:::

New keys receive `["invoices:write", "invoices:read"]`.

### `POST /api/v1/admin/tenants/{tenantId}/api-keys/{keyId}/rotate`

```bash
curl -X POST localhost:3000/api/v1/admin/tenants/$TENANT/api-keys/$KEY/rotate \
  -H "authorization: Bearer $ADMIN"
```

Returns a new key in the same shape. The old key's status becomes `rotating` and it stays valid for **7 days**, so an integration can roll over without a coordinated cutover:

1. Rotate; store the new key.
2. Deploy it at your leisure.
3. The old key expires on its own.

Name, environment and scopes are copied from the old key; the new one is named `"<old name> (rotated)"` and records `rotated_from`.

Both the rotation and the creation are written to the hash-chained audit log.

### `DELETE /api/v1/admin/tenants/{tenantId}/api-keys/{keyId}`

```bash
curl -X DELETE localhost:3000/api/v1/admin/tenants/$TENANT/api-keys/$KEY \
  -H "authorization: Bearer $ADMIN"
```

`204 No Content`. **Immediate, no grace period.** The next request with that key gets `401 ERR_AUTH_REVOKED`.

Revoke on compromise; rotate on schedule. A revoked key that is still in use produces an outage, which is the intended behaviour when a key has leaked.

### `GET /api/v1/admin/tenants/{tenantId}/api-keys`

```json
{
  "data": [
    { "id": "c4e1...", "key_prefix": "passo_live_kJ8x", "name": "production",
      "environment": "live", "scopes": ["invoices:write","invoices:read"],
      "status": "active", "expires_at": null,
      "last_used_at": "2026-09-01T10:15:00.000Z",
      "created_at": "2026-09-01T09:05:00.000Z" }
  ],
  "requestId": "..."
}
```

`key_hash` is not selected. `last_used_at` is how you find keys nobody is using any more — a good input to a revocation sweep.

---

## Sellers

A **seller** is a legal entity that issues invoices. One tenant can hold many; `CedentePrestatore` comes from here, while the transmitter comes from the tenant.

### `POST /api/v1/admin/tenants/{tenantId}/sellers`

```bash
curl -X POST localhost:3000/api/v1/admin/tenants/$TENANT/sellers \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{
    "taxRegime": "RF01",
    "denomination": "Fornitore S.r.l.",
    "vatCountry": "IT",
    "vatCode": "01234567890",
    "taxCode": "01234567890",
    "address": {
      "street": "Via Roma", "streetNumber": "12", "postalCode": "20100",
      "city": "Milano", "province": "MI", "country": "IT"
    }
  }'
```

| Field | Required | Notes |
|---|---|---|
| `taxRegime` | **yes** | `RegimeFiscale` — `RF01`–`RF20` excluding `RF03` |
| `denomination` | conditional | A company |
| `firstName` + `lastName` | conditional | A natural person |
| `address` | **yes** | |
| `vatCountry`, `vatCode` | no | Partita IVA |
| `taxCode` | no | Codice Fiscale |

Three explicit validations: `taxRegime` is required; you must supply `denomination` **or** both `firstName` and `lastName`; `address` is required. A `sellers_name_chk` CHECK constraint enforces the naming rule at the database layer too.

Returns `201` with the id — this is the `sellerId` you pass to `POST /invoices`.

### `GET /api/v1/admin/tenants/{tenantId}/sellers`

```json
{
  "data": [
    { "id": "3f1a...", "denomination": "Fornitore S.r.l.",
      "first_name": null, "last_name": null,
      "vat_country": "IT", "vat_code": "01234567890", "tax_regime": "RF01" }
  ],
  "requestId": "..."
}
```

The address is not returned by the list endpoint.

---

## Channels

### `PUT /api/v1/admin/tenants/{tenantId}/channels/{channel}`

`{channel}` is one of `pec`, `invoicetronic`, `openapi`, `mock`. An unknown name is `400 ERR_CHANNEL_NOT_CONFIGURED`.

The whole request body becomes the channel config, encrypted with AES-256-GCM before storage.

**PEC:**

```bash
curl -X PUT localhost:3000/api/v1/admin/tenants/$TENANT/channels/pec \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{
    "smtpHost": "smtps.pec.example.it", "smtpPort": 465, "smtpSecure": true,
    "imapHost": "imaps.pec.example.it", "imapPort": 993, "imapSecure": true,
    "user": "azienda@pec.example.it",
    "password": "..."
  }'
```

**Invoicetronic:**

```bash
curl -X PUT localhost:3000/api/v1/admin/tenants/$TENANT/channels/invoicetronic \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"apiKey":"...","requestSigning":true}'
```

**OpenAPI.it:**

```bash
curl -X PUT localhost:3000/api/v1/admin/tenants/$TENANT/channels/openapi \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"token":"...","requestSigning":true}'
```

```json
{ "channel": "pec", "configured": true, "requestId": "..." }
```

::: warning This is exclusive, not additive
The handler sets `active = false` on every existing channel for the tenant before upserting the new one. A tenant transmits through exactly one channel at a time, and switching is a `PUT` to the new one — not a delete of the old.
:::

`sdiAddress` is **not** something you configure for PEC. SdI assigns a per-transmitter address in its first reply, and PASSO learns and stores it in the `pec_sdi_address` column — outside the encrypted blob, so address discovery can update it without rewriting credentials. See [SdI channels](/integrations/channels).

The operation is written to the audit log as `channel.configure` with the channel name, and no credential content.

### `GET /api/v1/admin/tenants/{tenantId}/channels`

```json
{
  "data": [
    { "channel": "pec", "active": true,
      "pec_sdi_address": "sdi23@pec.fatturapa.it",
      "pec_address_source": "assigned",
      "updated_at": "2026-09-01T10:00:00.000Z" }
  ],
  "requestId": "..."
}
```

Deliberately excludes `config_encrypted` and its IV, tag and key version. You learn which channel is active and whether SdI has assigned a dedicated PEC address (`pec_address_source` is `default` until it has), and nothing else.

::: tip Check `pec_address_source` after your first submission
While it reads `default`, submissions still go to `sdi01@pec.fatturapa.it`, where SdI says delivery is "not guaranteed". Once it flips to `assigned` the learned address is in use.
:::

---

## Webhooks

### `POST /api/v1/admin/tenants/{tenantId}/webhooks`

```bash
curl -X POST localhost:3000/api/v1/admin/tenants/$TENANT/webhooks \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{
    "url": "https://crm.example.com/hooks/passo",
    "events": ["invoice.delivered","invoice.rejected","invoice.exception"]
  }'
```

| Field | Required | Default |
|---|---|---|
| `url` | yes | — |
| `events` | no | `["invoice.delivered", "invoice.rejected"]` |

An empty `events` array means "every event" — the dispatcher only filters when the list is non-empty.

```json
{
  "id": "9b2c...",
  "secret": "whsec_x7Kp2mN9qR4tV6wY8zA1bC3d",
  "url": "https://crm.example.com/hooks/passo"
}
```

::: danger The webhook secret is shown once
Like an API key. It is encrypted at rest with AES-256-GCM and no endpoint returns it again. Store it now — it is what verifies the `X-Passo-Signature` header on every delivery. See [Notifications & webhooks](/api/webhooks).
:::

The URL is validated **and DNS-resolved** before it is stored:

- HTTPS required (HTTP is permitted only when `NODE_ENV` is not `production`)
- Credentials in the URL are rejected
- The resolved address must not be loopback, private, link-local or CGNAT

A blocked URL raises an `SsrfError`. The same check runs again immediately before every delivery, because a hostname that resolved public at registration can resolve private later. See [Security](/operations/security).

This is the operator bootstrap. A CRM manages its own subscriptions with a tenant key — list, patch, delete, rotate, delivery history — at [`/api/v1/webhooks`](/api/webhooks#managing-subscriptions). Registering a second webhook does not replace the first; both receive deliveries.

---

## Transformations

### `POST /api/v1/admin/tenants/{tenantId}/transformations`

```bash
curl -X POST localhost:3000/api/v1/admin/tenants/$TENANT/transformations \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{
    "name": "acme-crm-v1",
    "sourceFormat": "acme-json",
    "rules": [
      { "target": "number", "source": "doc.reference", "required": true },
      { "target": "date", "source": "doc.issued",
        "transform": [{ "fn": "dateFormat" }] },
      { "target": "lines[].totalPrice", "source": "items[].amount_cents",
        "transform": [{ "fn": "divide", "arg": 100 },
                      { "fn": "toDecimalString", "arg": 2 }] }
    ]
  }'
```

The template is validated by `validateTemplate` **at save time** — the function whitelist, the rule and chain limits, the regex safety check and the monetary-target rules all run here. An invalid template is rejected now rather than failing on an invoice later.

```json
{ "id": "e5d8...", "name": "acme-crm-v1", "rules": 3, "requestId": "…" }
```

`POST` upserts on `(tenant_id, name)`: `201` on insert, `200` on replace.

### `GET /api/v1/admin/tenants/{tenantId}/transformations`

Name, source format, rule count, timestamps. Not the rules themselves.

### `GET /api/v1/admin/tenants/{tenantId}/transformations/{name}`

The full template, rules included. `404` if missing.

### `DELETE /api/v1/admin/tenants/{tenantId}/transformations/{name}`

`204`. In-flight invoices that already named this template fail at submit with `404`.

A tenant can dry-run and clone starters without the admin key — see [Transformations API](/api/transformations). The rule language is in [Transformations](/integrations/transformations).

`POST /invoices` applies a template only when the body names it (`"transformation": "acme-v1"`). Nothing is applied by default.

---

## Audit

### `GET /api/v1/admin/tenants/{tenantId}/audit/verify`

```bash
curl localhost:3000/api/v1/admin/tenants/$TENANT/audit/verify \
  -H "authorization: Bearer $ADMIN"
```

```json
{ "ok": true }
```

Broken:

```json
{ "ok": false, "brokenAtId": "4471" }
```

The audit log is **hash-chained**: each row's hash covers the previous row's hash, so deletion and reordering are detectable — not just field edits. Verification walks the tenant's rows in id order and checks that each `prev_hash` matches the previous row's `hash`.

::: warning What a per-tenant verification can and cannot prove
The chain is global across the instance, while `audit_log` is tenant-scoped. So this call proves that **your rows form an unbroken subsequence** — which is exactly what detects a deletion among them. It cannot say anything about rows belonging to other tenants, which RLS hides.

Full-instance verification is an operator task run with elevated privileges.
:::

An `ok: false` is an incident. Investigate before doing anything else — the chain does not break by accident.

The same check is available as `passo-cli audit verify <tenantId>`, which exits non-zero on failure and is therefore usable from cron.

---

## Quarantine

A quarantined notification is an SdI receipt whose owning tenant could **not** be determined — it matched no correlation record — or one belonging to the v2 inbound-reception flow (`MT`, `EC`, `SE`).

::: warning This is not a RabbitMQ dead-letter queue
These endpoints read `quarantined_notifications`, a database table. They are the API twin of `passo-cli quarantine list`, **not** of `passo-cli dlq list`. RabbitMQ dead letters are inspected through the broker and the CLI.
:::

Both routes are **global**, not tenant-scoped, and sit directly under `/admin` with no `tenantId` in the path. `quarantined_notifications` has no `tenant_id` column at all — the row exists precisely because routing to a tenant failed, so there is nothing to scope by.

### `GET /api/v1/admin/quarantine`

The metadata listing.

```bash
curl localhost:3000/api/v1/admin/quarantine -H "authorization: Bearer $ADMIN"
```

```json
{
  "data": [
    { "id": "aa11...", "type": "MT", "identificativo_sdi": "9931",
      "filename": "IT01234567890_00003_MT_001.xml",
      "reason": "receiver-flow notification (MT) — inbound reception is v2",
      "channel": "pec",
      "created_at": "2026-09-01T11:20:00.000Z" }
  ],
  "requestId": "..."
}
```

Unresolved entries only (`resolved_at IS NULL`), newest first, capped at 200.

This reads the `quarantine_index` view, which deliberately **omits the `raw` column**. Listing orphaned receipts is a routine operator action; reading a stranger's fiscal payload is not, and the two do not share a query.

Common reasons:

| Reason | Meaning |
|---|---|
| `no correlation record matched` | The receipt arrived after the correlation record expired (~90 days), or for a submission this instance never made |
| `receiver-flow notification (MT\|EC\|SE) — inbound reception is v2` | A legitimate message for a flow not yet implemented |

### `GET /api/v1/admin/quarantine/{id}`

The raw payload, fetched deliberately and one row at a time.

```bash
curl localhost:3000/api/v1/admin/quarantine/aa11... -H "authorization: Bearer $ADMIN"
```

```json
{
  "data": {
    "id": "aa11...", "type": "MT", "identificativo_sdi": "9931",
    "filename": "IT01234567890_00003_MT_001.xml",
    "reason": "receiver-flow notification (MT) — inbound reception is v2",
    "channel": "pec",
    "raw": "<?xml version=\"1.0\"?><types:MetadatiInvioFile …>",
    "created_at": "2026-09-01T11:20:00.000Z"
  },
  "requestId": "..."
}
```

`404 ERR_NOT_FOUND` for an unknown id.

::: danger The raw payload is a stranger's fiscal document
The split between these two endpoints is a containment control, not an API-design preference.

A quarantined receipt cannot be attributed to a tenant, so RLS cannot protect it — and before this split, the tenant-scoped application role held full `SELECT` on the table and could read every unattributable receipt in the instance.

Now `passo_app` holds **`INSERT` only** — the ingest path must still be able to quarantine an unmatched receipt, and writing is not reading. Reads go through a dedicated `passo_quarantine` role (`NOINHERIT`, assumed deliberately per transaction), and the routine listing uses a view that does not expose `raw` at all.

Fetching a raw payload is therefore an explicit, single-row, admin-authenticated act. Treat it as one.
:::

::: tip Quarantined notifications are never discarded
Over PEC the mailbox is the only copy of a legal receipt. The raw XML is retained in full so it can be examined and, if the correlation is identified, handled by hand.
:::

---

## Alerts

Where a tenant's alerts go — email and/or webhook, both optional. See
[Alerts](/operations/alerts) for what raises them and the payload.

### `PUT /api/v1/admin/tenants/{tenantId}/alerts`

```bash
curl -X PUT localhost:3000/api/v1/admin/tenants/$TENANT/alerts \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"emails":["amministrazione@cliente.it"],"webhookUrl":"https://crm.cliente.it/hooks/alerts"}'
```

| Field | Notes |
|---|---|
| `emails` | Array (or comma-separated string), at most 10. Needs `ALERT_SMTP_HOST` to be sent — the response warns if it is unset |
| `webhookUrl` | HTTPS, SSRF-checked. A new URL returns `webhookSecret` once; `null` removes the webhook |

### `GET /api/v1/admin/tenants/{tenantId}/alerts`

The saved destinations, never the secret, plus whether SMTP and the operator destinations are configured.

### `DELETE /api/v1/admin/tenants/{tenantId}/alerts`

Removes the tenant's destinations. `204`.

### `POST /api/v1/admin/tenants/{tenantId}/alerts/test`

Sends a test alert to the tenant's and the operator's destinations now, and reports each.

### `GET /api/v1/admin/alerts`

Alerts across all tenants, open first. `?status=all` includes resolved ones; `?tenantId=` filters.

## MCP keys

Separate from API keys. The holder is a language model: default scopes are read-mostly (`invoices:read`, `webhooks:read`). Retry is opt-in. The key is `passo_mcp_…`, shown once. See [MCP server](/integrations/mcp).

| Method | Path |
|---|---|
| POST | `/admin/tenants/{tenantId}/mcp-keys` |
| GET | `/admin/tenants/{tenantId}/mcp-keys` |
| POST | `/admin/tenants/{tenantId}/mcp-keys/{keyId}/rotate` |
| DELETE | `/admin/tenants/{tenantId}/mcp-keys/{keyId}` |

```bash
curl -X POST localhost:3000/api/v1/admin/tenants/$TENANT/mcp-keys \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"claude-desktop","expiresInDays":90}'
```

## Channel health and usage

### `GET /api/v1/admin/tenants/{tenantId}/channels/health`

On-demand probe of the tenant's active channel. Always `200` — a down vendor is reported in the body (`ok: false`), it does not take the API out of rotation.

### `GET /api/v1/admin/tenants/{tenantId}/usage`

Request counts, errors, 429s, p50/p95/p99. Query `from`, `to`, `groupBy` (`day` default, or `route`, `key`). Cap 200 buckets. RLS-scoped to that tenant.

## Full endpoint list

| Method | Path |
|---|---|
| POST | `/admin/tenants` |
| GET | `/admin/tenants` |
| POST | `/admin/tenants/{tenantId}/api-keys` |
| GET | `/admin/tenants/{tenantId}/api-keys` |
| POST | `/admin/tenants/{tenantId}/api-keys/{keyId}/rotate` |
| DELETE | `/admin/tenants/{tenantId}/api-keys/{keyId}` |
| POST | `/admin/tenants/{tenantId}/sellers` |
| GET | `/admin/tenants/{tenantId}/sellers` |
| PUT | `/admin/tenants/{tenantId}/channels/{channel}` |
| GET | `/admin/tenants/{tenantId}/channels` |
| GET | `/admin/tenants/{tenantId}/channels/health` |
| POST | `/admin/tenants/{tenantId}/webhooks` |
| POST | `/admin/tenants/{tenantId}/transformations` |
| GET | `/admin/tenants/{tenantId}/transformations` |
| GET | `/admin/tenants/{tenantId}/transformations/{name}` |
| DELETE | `/admin/tenants/{tenantId}/transformations/{name}` |
| POST | `/admin/tenants/{tenantId}/mcp-keys` |
| GET | `/admin/tenants/{tenantId}/mcp-keys` |
| POST | `/admin/tenants/{tenantId}/mcp-keys/{keyId}/rotate` |
| DELETE | `/admin/tenants/{tenantId}/mcp-keys/{keyId}` |
| GET | `/admin/tenants/{tenantId}/usage` |
| GET | `/admin/tenants/{tenantId}/audit/verify` |
| GET | `/admin/quarantine` |
| GET | `/admin/quarantine/{id}` |
| PUT | `/admin/tenants/{tenantId}/alerts` |
| GET | `/admin/tenants/{tenantId}/alerts` |
| DELETE | `/admin/tenants/{tenantId}/alerts` |
| POST | `/admin/tenants/{tenantId}/alerts/test` |
| GET | `/admin/alerts` |

## Bootstrapping a tenant end to end

```bash
export ADMIN="your-admin-key"
export BASE="localhost:3000/api/v1/admin"

TENANT=$(curl -sX POST $BASE/tenants \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"Acme CRM","slug":"acme","transmitterCode":"01234567890"}' \
  | jq -r .id)

curl -sX PUT $BASE/tenants/$TENANT/channels/pec \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"smtpHost":"smtps.pec.example.it","smtpPort":465,
       "imapHost":"imaps.pec.example.it","imapPort":993,
       "user":"azienda@pec.example.it","password":"..."}'

SELLER=$(curl -sX POST $BASE/tenants/$TENANT/sellers \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"taxRegime":"RF01","denomination":"Fornitore S.r.l.",
       "vatCountry":"IT","vatCode":"01234567890",
       "address":{"street":"Via Roma","postalCode":"20100",
                  "city":"Milano","province":"MI","country":"IT"}}' \
  | jq -r .id)

curl -sX POST $BASE/tenants/$TENANT/webhooks \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"url":"https://crm.example.com/hooks/passo"}'
# ^ capture the whsec_ secret from this response

curl -sX POST $BASE/tenants/$TENANT/api-keys \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"production"}'
# ^ capture the passo_live_ key from this response

echo "tenant=$TENANT seller=$SELLER"
```

Two secrets appear in that transcript and nowhere else. Capture both.
