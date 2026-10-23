# How PASSO Works

PASSO is a relay. An invoice enters over HTTP, is validated and turned into FatturaPA XML, is durably stored, is transmitted to the Sistema di Interscambio through a pluggable channel, and the resulting receipts are pushed back to your CRM.

Nothing here is magic, and every hop exists to close a specific failure mode.

## The request lifecycle

```
                  ┌──────────────────── one transaction ────────────────────┐
                  │                                                          │
CRM ── POST ──▶ API ─▶ validate ─▶ generate XML ─▶ XSD gate ─▶ encrypt ─▶ INSERT
                  │                                                    invoices
                  │                                                    sdi_submissions
                  │                                                    correlation_records
                  │                                                    outbox
                  └────────────────────── COMMIT ──────────────────────────┘
                                              │
                                         202 Accepted
                                              │
                             relay ── drains outbox ──▶ RabbitMQ (passo.invoices)
                                                             │
                                                        q.submit-sdi
                                                             │
                                                  worker ── channel adapter ──▶ SdI
                                                             │
              ┌──────────────────────────────────────────────┘
              │
      receipts arrive:  vendor webhook  │  PEC IMAP poll
              │
        route by correlation record ─▶ apply to state machine ─▶ q.dispatch-webhook
              │
              └──────────── HMAC-signed webhook ──────────────▶ CRM
```

### 1. The API accepts, validates and generates — synchronously

`POST /api/v1/invoices` does real work before it answers. In `submitInvoice`:

1. The body is parsed with `InvoiceSchema` (Zod). A schema failure is `400 ERR_SCHEMA_INVALID` with a per-field issue list.
2. A B2G gate runs: if `format` is `FPA12` and the tenant's channel cannot sign server-side, the request is refused with `ERR_VALIDATION_SIGNATURE_REQUIRED` rather than transmitting an unsigned document to a public administration.
3. A `ProgressivoInvio` is allocated from a per-transmitter counter.
4. `generateInvoiceXml` builds the document.
5. `assertValidInvoiceXml` validates it against the bundled Agenzia delle Entrate XSD. **This gate is mandatory and non-skippable.** An invoice that fails here never reaches SdI.
6. Payload and XML are encrypted (AES-256-GCM) and the rows are inserted.

::: tip XML generation is not a queue stage
`q.transform`, `q.generate-xml` and `q.sign` are declared in the topology but have no consumer in this build. Generation and XSD validation happen inline in the API request. That is deliberate: a caller who sends structurally invalid data learns at once, with a `400`, instead of discovering it minutes later in a webhook.
:::

### 2. The transactional outbox

The last write inside that same transaction is not a message to RabbitMQ. It is a row in the `outbox` table:

```sql
INSERT INTO outbox (tenant_id, exchange, routing_key, payload)
VALUES ($1, 'passo.invoices', $2, $3);
```

Only after `COMMIT` does the caller receive `202 Accepted`. A separate **relay** process then drains the outbox into RabbitMQ.

#### Why the outbox exists: the dual-write problem

Writing to two systems — Postgres and RabbitMQ — cannot be made atomic. Whatever order you choose, a crash in the gap breaks something:

| Order | Crash in the gap | Result |
|---|---|---|
| Publish, then commit | Message published, transaction rolled back | **Phantom job.** A worker picks up a `submissionId` that does not exist. It cannot progress, cannot be retried meaningfully, and pollutes the DLQ. |
| Commit, then publish | Row committed, publish never happened | **Lost invoice.** The caller was told `202 Accepted`; the invoice sits in `queued` forever and is never transmitted. Silence is the worst outcome for a tax document. |

The outbox removes the gap entirely. There is only one write — to Postgres — and the message *is* a row in that same transaction. If the transaction commits, both the invoice and its job exist. If it rolls back, neither does. There is no interleaving that produces a phantom or a loss.

The relay is then free to be at-least-once. Publishing a duplicate is safe: the worker re-reads the submission's state and returns early when it is no longer submittable.

```ts
// src/infra/queue/outbox.ts — the drain loop
SELECT id, tenant_id, exchange, routing_key, payload
  FROM outbox
 WHERE published_at IS NULL
 ORDER BY id
 FOR UPDATE SKIP LOCKED
 LIMIT 100
```

`FOR UPDATE SKIP LOCKED` is what makes running several relay replicas correct: each grabs a disjoint batch instead of contending on the same rows.

::: warning Postgres is the durability boundary, not RabbitMQ
Nothing that matters survives only in the broker. If RabbitMQ is wiped, unpublished outbox rows are still there and republish on the next tick. Rows already marked `published_at` are a different matter — see [Backup & restore](/operations/backup).
:::

### 3. The worker submits

`startSubmitWorker` consumes `q.submit-sdi`. For each message it:

1. Sets the RLS tenant context from `msg.tenantId`.
2. Loads the submission and refuses to proceed unless its state is `queued` or `transmitting` — this is what makes duplicate delivery harmless.
3. Decrypts the XML.
4. Resolves the tenant's channel adapter and decrypts its credentials.
5. Calls `adapter.submit(...)`.

On success the state becomes `transmitted` and the correlation record is updated with whatever identifier the channel returned (`IdentificativoSdI` for vendors, the PEC `Message-ID` for mail).

On failure the adapter's `ChannelError` carries a `retryable` flag. Transient failures go back through the delayed exchange with exponential backoff; a `401` or a malformed payload dead-letters immediately, because retrying a deterministic failure five times just makes five identical failures.

### 4. Receipts come back two different ways

| Channel | Receipt path |
|---|---|
| Invoicetronic, OpenAPI.it | Vendor webhook (push) |
| PEC | IMAP poll every `PEC_POLL_INTERVAL_MS` (default 60 s) |
| Mock | Simulated, returned by `poll()` |

PEC is the odd one out and has no push option: SdI replies by email, so PASSO runs a real mail client. It uses **IMAP, never POP3** — POP3 deletes on read, so a crash between fetch and persist would permanently destroy a legal receipt, and over PEC the mailbox is the only copy.

### 5. Routing a receipt whose tenant is unknown

A notification arriving from SdI carries an `IdentificativoSdI` or a PEC `Message-ID`. It does **not** carry a tenant. And the tenant must be known before an RLS context can be set — so this one lookup cannot run inside a tenant context.

`routeNotification` therefore assumes the `passo_router` role and reads the `correlation_routing` view: six columns of identifiers and status, with no fiscal or personal data in it. That narrowness is what makes the RLS bypass acceptable. See [Multi-tenancy](/guide/tenancy).

If nothing matches, the notification is **quarantined, never discarded**:

```bash
passo-cli quarantine list
```

A receipt that matched nothing is still a legal document. Over PEC, throwing it away destroys the only copy in existence.

### 6. State transitions and the outbound webhook

`applyNotification` maps the notification type onto the submission state machine:

| Type | New state | Terminal |
|---|---|---|
| RC | `delivered` | yes |
| NS | `rejected` | yes |
| MC | `awaiting_delivery` | no |
| DT | `delivered` | yes |
| AT | `undelivered_attested` | yes |
| NE (`EC01`) | `accepted_by_pa` | yes |
| NE (`EC02`) | `rejected_by_pa` | yes |

Insertion into `notifications` uses `ON CONFLICT DO NOTHING` against a unique key on `(tenant_id, submission_id, type, sdi_message_id)`. Redelivery — a vendor retry, an IMAP re-read — becomes a no-op instead of a second state change.

The resulting event is enqueued (again through the outbox) to `q.dispatch-webhook`, where the webhook worker signs it with HMAC-SHA256 and POSTs it to every registered endpoint whose event filter matches.

## Three processes, one image

The Dockerfile builds a single image. `src/index.ts` selects a role from `argv[2]` or `PASSO_ROLE`:

| Role | What it runs | Why it is separate |
|---|---|---|
| `api` | Express HTTP server, admin + tenant routes | HTTP must stay responsive. A 30-second vendor timeout in a worker must never occupy an API request slot. |
| `worker` | `q.submit-sdi` and `q.dispatch-webhook` consumers, the purge scheduler, the PEC poller, the stall detector | Throughput-bound and I/O-blocking. Scales on queue depth, which has nothing to do with request rate. |
| `relay` | The outbox drain loop | Runs a tight `SELECT … SKIP LOCKED` poll every 200 ms. Mixing that into the API would mean every API replica hammering the outbox table. |
| `mcp` | MCP server over stdio, scoped to one tenant | Not a service at all — a short-lived process started on demand. See [MCP server](/integrations/mcp). |

The scaling argument is the whole argument. These three have unrelated load curves, unrelated failure modes and unrelated restart costs. Splitting them means a burst of invoices scales `worker` without touching `api`, and a wedged vendor connection kills one worker rather than degrading HTTP.

They share the image because they share the code — one build, one `npm ci`, one set of native bindings compiled once.

## Graceful shutdown

Every role registers `SIGTERM` and `SIGINT` handlers that run its teardown stack in order: stop the HTTP listener or the poll loop, close the broker connection, drain the pool, exit. Compose gives `api` and `worker` a 45-second `stop_grace_period` and `relay` 30 seconds.

An in-flight submission that is interrupted anyway is not lost: the outbox row or the unacked RabbitMQ message survives, and the job runs again after restart.

## What is deliberately *not* in the pipeline

::: warning Declared but not wired in this build
- **`q.transform`, `q.generate-xml`, `q.sign`, `q.pec-parse`, `q.notification`** are declared in `topology.ts` with retry policies, and their queues and DLQs are asserted at boot — but no consumer is registered for them. Only `q.submit-sdi` and `q.dispatch-webhook` have workers.
- **Transformations** are validated when saved (`POST /admin/tenants/:id/transformations`) but the engine is not invoked from the submission path. `submitInvoice` parses the caller's body with `InvoiceSchema` directly. See [Transformations](/integrations/transformations).
:::

Everything else on this page is what the code does today.
