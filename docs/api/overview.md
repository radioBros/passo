# API Overview

PASSO is API-only. There is no web UI, in this version or any later one — the Admin API and `passo-cli` are the whole operator surface.

## Base URL

```
http://localhost:3000/api/v1
```

There is no hosted instance. The host is wherever you deployed the stack. Set `PASSO_BASE_URL` to that address: it is used to build the `trackingUrl` returned with every accepted submission, and if it is wrong your CRM records unreachable links.

Two route groups exist under the same server:

| Prefix | Auth | For |
|---|---|---|
| `/api/v1` | Tenant API key | Submitting and tracking invoices |
| `/api/v1/admin` | Admin key | Provisioning tenants, keys, sellers, channels, webhooks |

## Authentication

Bearer token, in the `authorization` header:

```bash
curl localhost:3000/api/v1/pending \
  -H "authorization: Bearer passo_live_kJ8xN2pQ..."
```

Keys look like `passo_live_<24 random bytes, base64url>`. A `test` environment is also supported and produces `passo_test_…` — the prefix is part of the key, not a separate header, so a test key in a production config is visible at a glance in a log line or a config file.

Keys are stored as **bcrypt hashes** (cost 12). The plaintext is returned exactly once, at creation, and cannot be recovered afterwards. Lose it and you rotate.

Resolution narrows candidates by the 16-character prefix and then compares with bcrypt, which is constant-time internally. The key itself is never string-compared.

### Scopes

Two scopes exist, and new keys get both by default:

| Scope | Grants |
|---|---|
| `invoices:write` | `POST /invoices`, `/retry`, `/ack` |
| `invoices:read` | `GET /invoices/{id}`, `/xml`, `/rendered`, `/receipts`, `/pending`, `POST /render` |

A key missing the required scope gets `403 ERR_AUTH_SCOPE`. An admin-authenticated request bypasses the scope check.

### Admin authentication

The Admin API uses `PASSO_ADMIN_KEY` from the environment, compared with `timingSafeEqual` after a length check. It is a bootstrap credential — it is not stored in the database, cannot be rotated through the API, and grants access to every tenant. Treat it accordingly.

## Standard headers

**Request:**

| Header | Required | Purpose |
|---|---|---|
| `authorization` | yes | `Bearer <key>` |
| `content-type` | on POST | `application/json`, or `application/xml` for `POST /render` |
| `idempotency-key` | recommended | Safe retry of `POST /invoices` |
| `x-request-id` | no | Your own trace id; echoed back if supplied |

**Response:**

| Header | Meaning |
|---|---|
| `x-request-id` | The request id — yours if you sent one, otherwise a generated UUID |
| `x-ratelimit-limit` | The window's total budget |
| `x-ratelimit-remaining` | Requests left in the current window |
| `x-ratelimit-reset` | Seconds until the window resets |
| `x-ratelimit-bypassed` | `store-unavailable` — the limiter failed open (see below) |
| `retry-after` | Seconds until you may retry (on `429` only) |

The API also sets standard security headers via `helmet`: a maximally restrictive CSP (`default-src 'none'`, `frame-ancestors 'none'`, `sandbox`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: same-origin`. HSTS is emitted when `PASSO_HSTS_MAX_AGE` is greater than zero. `x-powered-by` and ETags are disabled.

### CORS

Off by default — no CORS headers are emitted at all. PASSO is a server-to-server relay, and a browser origin has no business holding a CRM's API key.

An operator opts in with an explicit allowlist in `PASSO_CORS_ORIGINS` (comma-separated). When set, `authorization`, `content-type` and `idempotency-key` are the allowed request headers, and the rate-limit and `x-request-id` headers are exposed.

`PASSO_CORS_ORIGINS=*` combined with `PASSO_CORS_CREDENTIALS=true` is refused **at boot**: browsers reject that pair, and an operator who sets it believes cross-origin auth works when it cannot.

## `requestId` in every response

Every JSON body carries a `requestId`, matching the `x-request-id` header:

```json
{
  "submissionId": "8f2a...",
  "status": "queued",
  "requestId": "b1c3e4f5-..."
}
```

Errors carry it too:

```json
{
  "error": {
    "code": "ERR_VALIDATION_FAILED",
    "message": "Invoice failed business validation",
    "retryable": false
  },
  "requestId": "b1c3e4f5-..."
}
```

Log it on your side. It is the only handle that ties your call to a line in the operator's logs, and it is the first thing an operator will ask for.

Supplying your own is often more useful — pass your CRM's job id as `x-request-id` and both systems' logs share a key.

## Idempotency

`POST /invoices` accepts an `idempotency-key` header. PASSO stores the key with a SHA-256 hash of the request body and the response it produced.

| Situation | Result |
|---|---|
| Same key, same body | The original response is replayed. No second invoice, no second `ProgressivoInvio`. |
| Same key, **different** body | `409 ERR_CONFLICT_IDEMPOTENCY` |
| New key | Processed normally |

Records expire **24 hours** after creation. A replay after that window creates a genuinely new submission, so an idempotency key is a protection against retry storms and network timeouts, not a permanent deduplication ledger.

```bash
curl -X POST localhost:3000/api/v1/invoices \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -H 'idempotency-key: crm-job-88213' \
  -d @invoice.json
```

::: tip Use your own job identifier
A random UUID generated per attempt defeats the purpose — a retry generates a fresh one and submits again. Derive the key from something stable on your side: the CRM invoice id, the outbox row id, the job id.
:::

## The 202-by-default contract

`POST /invoices` returns **202 Accepted**, not 201:

```json
{
  "submissionId": "8f2a1b3c-...",
  "status": "queued",
  "invoiceNumber": "2026/0042",
  "progressivoInvio": "0002P",
  "fileName": "IT01234567890_0002P.xml",
  "createdAt": "2026-09-01T10:00:00.000Z",
  "trackingUrl": "http://localhost:3000/api/v1/invoices/8f2a1b3c-...",
  "requestId": "..."
}
```

202 means: **validated, XSD-checked, encrypted, durably committed, and queued.** By the time you hold this response the invoice cannot be lost — a crash one millisecond later still transmits it, because the job lives in the same committed transaction as the invoice row.

What 202 does *not* mean: that SdI has seen it. Transmission is asynchronous, and the outcome arrives by webhook or by polling.

Note that failures which *can* be detected synchronously already have been. A `202` is never returned for a schema-invalid invoice, a zero-rate line missing its `Natura`, or a B2G invoice on an unsigned channel — those are `400`s.

### Bounded sync mode

`"mode": "sync"` makes the request wait, with a hard cap:

```json
{ "mode": "sync", "syncTimeoutMs": 30000, "sellerId": "...", "invoice": { … } }
```

The effective wait is `min(syncTimeoutMs, SYNC_MAX_WAIT_MS)` — you can only ask for *less* than the server's ceiling, never more. `SYNC_MAX_WAIT_MS` defaults to 120 s and is itself capped at 120 s by config validation.

| Outcome | Status | Body |
|---|---|---|
| Milestone reached in time | `200` | Same shape, with the reached status |
| Timeout | `202` | Standard accepted response — **the job continues untouched** |

::: warning Sync mode waits for transmission only
It resolves on the **`transmitted` (AT) milestone** and nothing further. It never waits for RC, MC, DT or NE.

That is not a limitation to be tuned around — it is a statement about the domain. MC delivery retry runs for *days*. DT is a multi-day PA response window. No HTTP timeout, at any value, can represent final delivery. A sync mode that pretended otherwise would just be a timeout that lies.

A timeout is not a failure and not a rollback. The invoice is already committed and queued; you simply stopped waiting.
:::

Use `sync` for interactive flows where a user is watching a spinner and a fast confirmation is worth the held connection. Use `async` — the default — for everything else.

## Rate limiting

Per-key sliding window: **100 requests per 60 seconds**, backed by Redis when available and by an in-process counter otherwise.

The bucket key is the API key id, falling back to the client IP for unauthenticated requests. Multiple keys for one tenant get independent buckets, which is one practical reason to issue a separate key per integration.

Exceeding it:

```
429 Too Many Requests
retry-after: 12
```

```json
{ "error": { "code": "ERR_RATE_LIMITED", "message": "Rate limit exceeded",
             "retryable": true }, "requestId": "..." }
```

`retryable: true` — back off for the advertised interval and retry.

::: warning The limits are compiled in, not configured
`.env.example` lists `RATE_LIMIT_POINTS` and `RATE_LIMIT_DURATION_SEC`, but nothing reads them: `createRateLimiter(d.redis)` is called with no arguments and takes the 100/60 defaults from the function signature. Setting those variables has no effect in this build. See [Configuration](/reference/configuration).
:::

An in-memory limiter is per process, so `N` API replicas without Redis effectively allow `N × 100` per minute. Run Redis if the limit needs to mean anything.

### The limiter fails open

A spent budget and an unreachable Redis both cause `limiter.consume()` to reject — but they are not the same event, and PASSO distinguishes them.

`rate-limiter-flexible` rejects with a `RateLimiterRes` carrying `msBeforeNext` when the caller is genuinely over budget, and with a plain `Error` when the store is down. Only the first produces a `429`.

When the store is unreachable the request is **allowed through**, a warning is logged, and the response carries:

```
x-ratelimit-bypassed: store-unavailable
```

::: tip Why fail open rather than closed
Redis holds nothing whose loss may block an invoice — it is a counter, not a durability boundary. Collapsing both rejection kinds into a `429` would let a Redis blip halt invoice submission for every tenant at once, turning a cache outage into a transmission outage.

If you see that header in production, Redis needs attention — but your invoices are still moving.
:::

## Pagination

Two list endpoints use a **cursor**, never an offset (an offset skips or repeats rows under concurrent inserts):

| Endpoint | Cursor | Default page | Cap |
|---|---|---|---|
| `GET /api/v1/invoices` | `cursor` = previous `nextCursor` (`created_at` plus `id`) | 50 | 200 |
| `GET /api/v1/webhooks/{id}/deliveries` | `before` = previous `nextCursor` | 50 | 200 |

Everything else is a bounded working set, not a report:

| Endpoint | Cap |
|---|---|
| `GET /api/v1/pending` | 200 rows, newest first |
| `GET /api/v1/invoices/{id}/receipts` | All receipts for that submission |
| `GET /api/v1/admin/quarantine` | 200 unresolved rows |
| MCP `list_pending` | 50 rows |
| MCP `list_submissions` | `limit` argument, default 20 |

PASSO is a relay, not an archive. `/pending` is a reconciliation queue you drain. If it sits at 200 rows, something upstream is not acknowledging. For historical reporting, query your CRM.

## Error format

Every error shares one envelope:

```json
{
  "error": {
    "code": "ERR_CONFLICT_NS_RETRY",
    "message": "Rejected by SdI (NS). NS is terminal — the invoice is legally not issued. Correct it and submit a NEW invoice; PASSO will allocate a new ProgressivoInvio.",
    "retryable": false,
    "details": []
  },
  "requestId": "..."
}
```

Branch on `code`, never on `message` — messages are prose and may be reworded. `retryable` tells you whether a bare retry could ever succeed. `details` appears on validation failures with a per-field breakdown.

See [Errors](/api/errors) for the full catalogue.

## Health endpoints

Both are unauthenticated and sit outside `/api/v1`.

```bash
curl localhost:3000/health/live    # {"status":"ok"}
curl localhost:3000/health/ready   # {"ok":true,"checks":{...}}
```

`/health/live` checks the process and nothing else — not even the database. `/health/ready` checks Postgres and Redis, and **deliberately excludes SdI vendors**: a vendor outage must not take PASSO out of rotation, because Postgres is the durability boundary and invoices accepted during the outage submit when the vendor returns. See [Deployment](/operations/deployment).

## Endpoint index

**Invoices** (`/api/v1`, tenant key):

| Method | Path | Scope |
|---|---|---|
| POST | `/invoices` | `invoices:write` |
| GET | `/invoices` | `invoices:read` |
| GET | `/invoices/{id}` | `invoices:read` |
| POST | `/invoices/{id}/retry` | `invoices:write` |
| GET | `/invoices/{id}/xml` | `invoices:read` |
| GET | `/invoices/{id}/rendered` | `invoices:read` |
| GET | `/invoices/{id}/receipts` | `invoices:read` |
| GET | `/invoices/{id}/export` | `invoices:read` |
| POST | `/invoices/{id}/ack` | `invoices:write` |
| GET | `/pending` | `invoices:read` |
| POST | `/render` | `invoices:read` |

**Webhooks**

| Method | Path | Scope |
|---|---|---|
| POST | `/webhooks` | `webhooks:write` |
| GET | `/webhooks` | `webhooks:read` |
| PATCH | `/webhooks/{id}` | `webhooks:write` |
| DELETE | `/webhooks/{id}` | `webhooks:write` |
| POST | `/webhooks/{id}/rotate-secret` | `webhooks:write` |
| GET | `/webhooks/{id}/deliveries` | `webhooks:read` |
| POST | `/inbound/{token}` | path token (vendor) |

**Transformations**

| Method | Path | Scope |
|---|---|---|
| POST | `/transformations/test` | `invoices:write` |
| GET | `/starter-templates` | `invoices:read` |
| GET | `/starter-templates/{key}` | `invoices:read` |
| POST | `/transformations/from-starter/{key}` | `transformations:write` |

**Catalogues and privacy**

| Method | Path | Scope |
|---|---|---|
| GET | `/scopes` | `invoices:read` |
| GET | `/webhook-events` | `invoices:read` |
| GET | `/sdi-errors` | `invoices:read` |
| GET | `/sdi-errors/{code}` | `invoices:read` |
| POST | `/privacy/erasure` | `invoices:read` |

**Health** (unauthenticated, outside `/api/v1`): `GET /health/live`, `GET /health/ready`.

**Admin** (`/api/v1/admin`, admin key): see [Admin API](/api/admin).

## Next

- [Submitting invoices](/api/invoices) — every invoice endpoint
- [Invoice data model](/api/invoice-model) — every field and enum
- [Notifications & webhooks](/api/webhooks) — events, signatures, management
- [Transformations](/api/transformations) — dry-run and starters
- [Privacy and export](/api/privacy) — pre-purge package and erasure
- [Errors](/api/errors) — the full catalogue
- [OpenAPI reference](/api/reference) — generated contract
