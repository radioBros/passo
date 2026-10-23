# Database Schema

Postgres 16. **19 tables** and **4 views** — 17 from the initial migration, plus `progressivo_counters` (migration 005) and `channel_health` (migration 010).

Fourteen tables are tenant-scoped and carry row-level security. Five deliberately are not.

## Conventions

**`TIMESTAMPTZ` everywhere.** Never `TIMESTAMP`. An invoice date is a `DATE` (FatturaPA's `Data` has no time component), but every event time — `created_at`, `received_at`, `terminal_at`, `purged_at` — is timezone-aware.

Bare `TIMESTAMP` stores a wall-clock reading with no zone, so its meaning depends on the reading session's `TimeZone` setting. For a system correlating a receipt from the Italian tax authority against a submission made from a server in another zone, that ambiguity is unacceptable. `TIMESTAMPTZ` stores an absolute instant.

Most tables carry `created_at` and `updated_at` defaulting to `now()`, with a `touch_updated_at()` trigger maintaining `updated_at` on eight of them.

**UUID primary keys**, `gen_random_uuid()` from `pgcrypto`. Two exceptions use `bigserial` because they are append-only sequences where order matters: `outbox` and `audit_log`. `progressivo_counters` is keyed by `transmitter_id` text.

**`NUMERIC(19,8)` for stored money.** There is exactly **one** such column — `invoices.total_amount` — and it is nullable, denormalised, and not on the generation path.

::: tip Money is a string almost everywhere, not a numeric column
FatturaPA amounts are patterned strings, and PASSO carries them as decimal strings through the API, the model and the generator, parsed into `decimal.js` for arithmetic. They live inside the **encrypted** payload and XML blobs, not in typed columns.

`invoices.total_amount` is the only exception — a convenience column. So `NUMERIC(19,8)` is the convention for *stored* money, but it applies to a single field. Do not expect line amounts, tax amounts or summaries as queryable numeric columns; they are inside `payload_encrypted`.

Where it is used, 19 digits with 8 decimals comfortably exceeds FatturaPA's own limits (11 integer digits, up to 8 decimals) and never uses floating point.
:::

**Encrypted columns come in fours.** Every encrypted field is stored as four columns:

```
<name>_encrypted    bytea    ciphertext
<name>_key_version  text     which key encrypted it
<name>_iv           bytea    12-byte GCM nonce
<name>_tag          bytea    16-byte auth tag
```

The key version is what allows rotation without re-encryption — a row written under `v1` keeps decrypting under `v1` after `v2` becomes active. See [Security](/operations/security).

---

## Tenant-scoped tables (14)

Each has a `tenant_id` column, `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, and a `tenant_isolation` policy with both `USING` and `WITH CHECK`.

| Table | Purpose |
|---|---|
| `sellers` | Legal entities that issue invoices. `CedentePrestatore` |
| `invoices` | Invoice metadata + the encrypted caller payload |
| `sdi_submissions` | One transmission attempt: progressivo, filename, state, encrypted XML |
| `correlation_records` | The forwarding address — IDs and status only |
| `notifications` | Received SdI receipts |
| `outbox` | Transactional outbox rows awaiting publication |
| `api_keys` | Tenant API keys (bcrypt hashes) |
| `mcp_keys` | MCP keys — **unused in this build** |
| `webhooks` | Registered endpoints + encrypted signing secrets |
| `webhook_deliveries` | Per-attempt delivery log |
| `transformations` | Saved mapping templates |
| `channel_credentials` | Encrypted channel config + learned PEC address |
| `idempotency_keys` | Replay records, 24-hour TTL |
| `audit_log` | Hash-chained audit trail |

### `sellers`

`tax_regime` is `NOT NULL` — `RegimeFiscale` is mandatory on every invoice. A CHECK enforces the naming rule:

```sql
CHECK ((denomination IS NOT NULL) OR (first_name IS NOT NULL AND last_name IS NOT NULL))
```

A company or a natural person, never neither. `address` is `jsonb`.

### `invoices`

Holds metadata plus the caller's original payload, encrypted. `total_amount` is the one `numeric(19,8)`.

```sql
UNIQUE (tenant_id, seller_id, invoice_number)
```

Invoice numbers are unique per seller, not per tenant — one tenant billing for several companies has independent numbering sequences, which is how Italian invoice numbering actually works.

::: tip There is deliberately no `retention_until` column
The payload is **transient**. It is purged once a terminal receipt arrives, and `purged_at` records when. PASSO keeps no archive, so there is no retention date to store.
:::

### `sdi_submissions`

One row per transmission attempt. Carries the generated XML (encrypted), its SHA-256, the filename, the state and the SdI identifier.

```sql
UNIQUE (transmitter_id, progressivo_invio)
```

`ProgressivoInvio` must be unique per transmitter, forever. An NS retry allocates a **new** value — reusing a rejected one yields a duplicate rejection, because SdI has already seen it.

`schema_version` defaults to `VFPR12_v1.2.3`, recording which XSD validated the document.

`state` is the submission state machine: `queued` → `transforming` → `generating` → `signing` → `transmitting` → `transmitted` → one of `delivered`, `rejected`, `awaiting_delivery`, `accepted_by_pa`, `rejected_by_pa`, `undelivered_attested`, `failed`.

`terminal_at` is the purge trigger. `purged_at` records that it happened.

### `correlation_records`

The forwarding address, and the reason PASSO can be a relay rather than an archive.

```sql
tenant_id · submission_id · crm_invoice_ref · progressivo_invio
transmitter_id · identificativo_sdi · pec_message_id · status
transmitted_at · terminal_at · expires_at · created_at · updated_at
```

::: danger What this table deliberately does NOT contain
**No fiscal data. No personal data.** No party names, no addresses, no VAT numbers, no amounts, no line items, no XML.

Identifiers and a status. That is all.

This is what keeps PASSO out of scope for the 10-year invoice retention requirement and for *conservazione a norma*. Those obligations attach to holding invoice **content**. A record saying "submission `8f2a…` with progressivo `0002P` reached status `delivered`" is not an invoice — it cannot be reconstituted into one, and it discloses nothing about the transaction.

The consequence you must plan for: after purge, PASSO can tell you an invoice was delivered and give you its identifiers. It cannot give you the invoice back. **Your CRM is the system of record.** See [What PASSO is not](/guide/scope).
:::

It outlives the payload on purpose. Payload and XML are purged as soon as a terminal receipt arrives, but the correlation record survives ~90 days so a **late** receipt can still be routed — an `MC` means SdI keeps retrying delivery for days, and the eventual `RC` must still find its tenant.

Indexed on `identificativo_sdi`, `pec_message_id`, `(transmitter_id, progressivo_invio)` and `expires_at` — the four ways a receipt is matched, plus the purge scan.

::: warning `expires_at` is set to a hardcoded 90 days
`submitInvoice` inserts `now() + interval '90 days'` literally. `CORRELATION_RETENTION_DAYS` is validated and available but not read at insert time. Changing it does not change the expiry of new records.
:::

### `notifications`

Received SdI receipts, raw XML encrypted, with a parsed `jsonb` summary.

Three constraints, each load-bearing:

```sql
CHECK (type IN ('RC','NS','MC','NE','DT','AT','MT','EC','SE'))
```

All **nine** types. Six address the transmitter; `MT`, `EC` and `SE` belong to the v2 inbound flow and must be *recognised* so a legitimate message is quarantined rather than treated as corruption.

```sql
CHECK (purge_eligible_at IS NULL OR acknowledged_at IS NOT NULL)
```

::: danger An unacknowledged receipt can never become purge-eligible
This is the constraint that makes the acknowledgement contract real.

Purge logic in application code is a policy. A CHECK constraint is a guarantee — no code path, no migration, no operator script and no future refactor can set `purge_eligible_at` on a receipt that has not been acknowledged. The attempt fails at the database.

An SdI receipt is a legal document. Deleting one your CRM never confirmed receiving destroys evidence, and "the purge job had a bug" is not an answer anyone wants to give. **Age alone is never sufficient.**
:::

```sql
UNIQUE (tenant_id, submission_id, type, sdi_message_id)
```

Redelivery is expected — vendor webhook retries, IMAP re-reads. The unique key plus `ON CONFLICT DO NOTHING` makes a duplicate a no-op rather than a second state transition.

`acknowledged_at` and `ack_method` record how the acknowledgement happened (`explicit_ack` from `POST /invoices/{id}/ack`).

### `outbox`

```sql
id bigserial · tenant_id · exchange · routing_key · payload jsonb
published_at · attempts · created_at
```

Written in the **same transaction** as the invoice it belongs to. That is what closes the dual-write hole. See [How PASSO works](/guide/architecture#the-transactional-outbox).

A partial index keeps the relay's scan cheap regardless of how much history accumulates:

```sql
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
```

::: warning Published rows are never deleted
Nothing prunes this table. It grows forever. On a busy instance, add your own periodic `DELETE FROM outbox WHERE published_at < now() - interval '30 days'`.

Note also that a published row is never republished. If RabbitMQ loses the message, that submission stalls — see [Backup & restore](/operations/backup#why-rabbitmq-is-mostly-reconstructible).
:::

### `api_keys` and `mcp_keys`

`key_hash` is bcrypt (cost 12) and `UNIQUE`; `key_prefix` is the 16-character lookup narrowing. The plaintext is never stored.

`status` is `active`, `rotating` or `revoked`; `rotated_from` links a key to its predecessor.

::: warning `mcp_keys` is unused
Same shape as `api_keys`, created by the initial migration, and read or written by nothing in this build. MCP scoping comes from the `PASSO_MCP_TENANT_ID` environment variable at process start, not from a credential. See [MCP server](/integrations/mcp).
:::

### `webhooks` and `webhook_deliveries`

`webhooks` holds the URL, an events array and the encrypted HMAC secret (all four secret columns `NOT NULL` — a webhook without a signing secret is not a valid webhook).

`webhook_deliveries` logs every attempt with its `event_id`, `attempt`, `http_status`, `error`, `delivered_at` and `next_retry_at`. It is the forensic trail for "did you send it?" — indexed on `(tenant_id, webhook_id)` and `next_retry_at`.

It has no retention policy and grows with delivery volume.

### `channel_credentials`

Encrypted config plus three columns that are **learned state, not configuration**:

```sql
pec_sdi_address         text default 'sdi01@pec.fatturapa.it'
pec_address_source      text default 'default'
pec_address_assigned_at timestamptz
```

::: tip Why the PEC address is a column and not part of the encrypted blob
SdI assigns a per-transmitter PEC address in its first reply, and all later submissions must use it. Continuing with `sdi01@` raises **no error** — delivery is merely "not guaranteed".

Keeping it outside the ciphertext lets address discovery update it without decrypting and rewriting the credentials, and lets `GET /admin/tenants/{id}/channels` report it without exposing anything sensitive.

`pec_address_source` reads `default` until SdI has assigned one, then `assigned`.
:::

`UNIQUE (tenant_id, channel)` — one config per channel per tenant, with `active` selecting which is in use.

### `idempotency_keys`

```sql
UNIQUE (tenant_id, key)
```

Stores `request_hash` (SHA-256 of the body) and the `response` to replay. Same key + same body replays; same key + different body is `409 ERR_CONFLICT_IDEMPOTENCY`.

`expires_at` is a hardcoded `now() + interval '24 hours'`.

::: warning Expired rows are not pruned
The purge job does not touch this table, and lookups filter on `expires_at > now()`. Rows accumulate. Add your own cleanup on a busy instance.
:::

### `audit_log`

```sql
id bigserial · tenant_id · actor · action · resource_type · resource_id
detail jsonb · ip inet · prev_hash · hash · created_at
```

`bigserial` because order is part of the guarantee. `prev_hash` and `hash` form the chain: each row's hash covers the previous row's hash plus its own payload, so **deletion and reordering** are detectable — not merely field edits.

`tenant_id` is nullable, the only tenant-scoped table where that is true. Instance-level actions have no tenant.

Actors: `api`, `admin`, `mcp`, `worker`, `purge-job`, `channel:<name>`.

::: warning The chain is global; the table is tenant-scoped
A row's `prev_hash` may belong to another tenant's row, which RLS hides. So `verifyAuditChain(tenantId)` proves your rows form an unbroken subsequence and nothing more. Full-instance verification is an operator task. See [Security](/operations/security#the-hash-chained-audit-log).
:::

---

## Non-tenant-scoped tables (5)

These have **no `tenant_id` column** and no RLS policy. Each for a different, specific reason.

### `tenants`

The tenancy root. It is read during tenant *resolution* — before any `app.tenant_id` context can exist — so it cannot itself be tenant-scoped. That would be circular.

```sql
CHECK (status IN ('active','suspended','deactivated'))
```

The `api_key_auth` view joins on `status = 'active'`, so suspension stops keys resolving at the database layer rather than in an application branch someone could later delete.

`transmitter_country` + `transmitter_code` form the `IdTrasmittente` and key the `ProgressivoInvio` counter.

### `encryption_keys`

Key **metadata only**: version, algorithm, state, `created_at`, `retired_at`.

::: danger Key material never lives here
Storing keys next to the ciphertext they protect defeats the entire point of encrypting. Material comes from `EnvKeyProvider` — environment variables, or a `0600` file named by `PASSO_KEY_FILE`.

This table is a registry of which versions exist, not a keystore.
:::

Not tenant-scoped because keys are instance-wide.

### `quarantined_notifications`

A receipt whose owning tenant could **not** be determined.

```sql
id · reason · type · identificativo_sdi · filename · raw
channel · resolved_at · resolved_by · created_at
```

::: danger No `tenant_id`, no RLS, and no possible RLS
The row exists **precisely because** routing to a tenant failed. There is nothing to scope by — a `tenant_id` column would have to be null on every row, and a policy over it would filter everything.

That is correct by design, and it made the table a cross-tenant hole: `passo_app` held full `SELECT` and could read every tenant's raw fiscal receipt regardless of context.

Since RLS cannot help, containment comes from **grants** (migration 009):

```sql
REVOKE ALL   ON quarantined_notifications FROM passo_app;
GRANT INSERT ON quarantined_notifications TO   passo_app;
GRANT SELECT, UPDATE ON quarantined_notifications TO passo_quarantine;
```

`passo_app` keeps `INSERT` and loses `SELECT` — the ingest path must still be able to quarantine an unmatched receipt, and **writing is not reading**. Reads go through `passo_quarantine`, which is `NOINHERIT` and must be assumed deliberately.
:::

`raw` is plain `text`, not encrypted — the payload cannot be encrypted with a tenant-bound AAD when the tenant is unknown, which is another way of saying the grant-based containment is doing the work here.

::: tip Never discarded, never purged
Over PEC the mailbox is the only copy of a legal receipt. The purge job does not touch this table; entries persist until an operator resolves them.
:::

### `progressivo_counters`

```sql
transmitter_id text PRIMARY KEY · next_value bigint · updated_at
```

Not tenant-scoped because it is keyed by **transmitter**, and `ProgressivoInvio` uniqueness is a per-transmitter guarantee that must hold across everything.

::: warning Why this table exists at all
The first implementation derived the next value from `COUNT(*)` of existing submissions. That is wrong: an NS retry burns a value and leaves a gap, so `count + 1` collides with a row that already exists.

The unique constraint caught it — but only after the transaction had done its work.

A counter that only ever moves forward makes gaps irrelevant. The `UPDATE … RETURNING` takes a row lock, which serialises concurrent allocators for the same transmitter without an explicit advisory lock.
:::

Migration 005 seeds it from existing data so an upgrade never re-issues a used value.

### `channel_health`

```sql
channel text PRIMARY KEY · poll_based bool · last_poll_at
last_error · last_error_at · created_at · updated_at
```

Seeded with one row per channel: `pec` with `poll_based = true`, the three others `false` — PASSO must poll PEC, while the vendors push webhooks.

Not tenant-scoped because a poller serves **every** tenant on its channel. "Did the PEC poller run?" is a question about the process, not about any one tenant's data. The table holds a channel name and timestamps — no invoice content.

::: tip Why a heartbeat table exists at all
A submission that reaches SdI and never hears back produces **no error**: nothing throws, no retry fires, no queue grows. It simply waits.

Detecting that needs a signal that exists even when nothing is in flight. Otherwise a poller that dies during a quiet hour is invisible until invoices pile up behind it — and by then the damage is measured in days.

`last_poll_at` is that signal. The poller writes it every cycle (as `passo_relay`); the stall detector reads it and reports a channel whose last poll is older than 30 minutes.
:::

Migration 010 also adds a partial index supporting that scan:

```sql
CREATE INDEX sdi_submissions_awaiting_idx
  ON sdi_submissions (channel, submitted_at)
  WHERE state IN ('transmitted', 'awaiting_delivery');
```

Age is measured from `submitted_at` — when the submission actually reached SdI — not from `created_at`. A job that sat in the queue was never waiting on SdI, and counting that time would report a backlog of PASSO's own making as SdI being slow.

---

## Views (4)

Each exists to narrow a role that must operate without a tenant context. The view *is* the security boundary — a compromised role sees a fixed, auditable column list, not a base table.

### `api_key_auth` — for `passo_auth`

```sql
CREATE VIEW api_key_auth AS
  SELECT k.id, k.tenant_id, k.key_hash, k.key_prefix, k.scopes,
         k.status, k.expires_at, k.revoked_at
    FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
   WHERE t.status = 'active';
```

Eight columns. Authentication resolves a key *before* the tenant is known — that lookup is how the tenant is determined — so it cannot run under an `app.tenant_id` context.

### `correlation_routing` — for `passo_router`

```sql
CREATE VIEW correlation_routing AS
  SELECT tenant_id, submission_id, crm_invoice_ref,
         progressivo_invio, identificativo_sdi, pec_message_id, status
  FROM correlation_records;
```

An arriving receipt carries an `IdentificativoSdI`, not a tenant. Compromising `passo_router` yields identifiers and statuses — no fiscal or personal data, because the base table has none either.

### `active_channels` — for `passo_relay`

```sql
CREATE VIEW active_channels AS
  SELECT tenant_id, channel FROM channel_credentials WHERE active = true;
```

Two columns. The PEC poller must ask "which tenants have an active PEC channel?" before it can know a tenant.

::: warning This one failed silently before it existed
Reading `channel_credentials` directly under RLS with no context returns **zero rows**, so the poller looped over an empty list forever. No receipts, no state transitions, and **no error**.
:::

### `quarantine_index` — for `passo_quarantine`

```sql
CREATE VIEW quarantine_index AS
  SELECT id, reason, type, identificativo_sdi, filename, channel,
         resolved_at, resolved_by, created_at
    FROM quarantined_notifications;
```

Deliberately **without `raw`**. Listing orphaned receipts is a routine operator action; reading a stranger's fiscal payload is not, and the two do not share a query.

---

## Migration history

| # | Migration | What it fixed or added |
|---|---|---|
| 0999999999999 | `bootstrap-roles` | Creates all roles **before** anything grants to them |
| 1000000000000 | `initial-schema` | 17 tables, RLS, two views, triggers |
| 1000000000001 | `rls-nullsafe` | `''::uuid` **raises**; `NULLIF` makes it fail closed |
| 1000000000002 | `relay-role` | `passo_relay`, granted `outbox` only |
| 1000000000003 | `purge-role` | `passo_purge`, granted its five tables |
| 1000000000004 | `auth-role` | `passo_auth` + the `api_key_auth` view |
| 1000000000005 | `progressivo-sequence` | Replaces `COUNT(*)+1` with a monotonic counter |
| 1000000000006 | `composite-tenant-fks` | Cross-tenant references made impossible |
| 1000000000007 | `router-grants` | The grant that was applied by hand and lost on rebuild |
| 1000000000008 | `channel-enumeration` | The view the PEC poller silently needed |
| 1000000000009 | `quarantine-containment` | Raw receipts unreadable by any tenant-scoped role |
| 1000000000010 | `channel-health` | A heartbeat for the failure mode that throws nothing |

Several of these are fixes for bugs that had already shipped, and their comments explain the failure rather than just the change. Two are worth reading directly:

**005** — `COUNT(*) + 1` collides after an NS retry burns a value.

**007** — the `correlation_routing` grant existed only because someone had run it by hand. A rebuilt database silently lost it and late-receipt routing failed with "permission denied". *Grants belong in migrations for exactly this reason: anything applied only by hand is absent from the next clean deployment.*

## Useful queries

Run these as a superuser, or with `SET LOCAL ROLE passo_purge` — under `passo_app` with no tenant context, RLS correctly returns zero rows.

**Submissions by state:**

```sql
SELECT state, count(*) FROM sdi_submissions GROUP BY state ORDER BY 2 DESC;
```

**Stuck submissions:**

```sql
SELECT s.id, s.state, s.created_at, i.invoice_number
  FROM sdi_submissions s JOIN invoices i ON i.id = s.invoice_id
 WHERE s.state IN ('queued','transmitting')
   AND s.created_at < now() - interval '15 minutes'
 ORDER BY s.created_at;
```

**Outbox lag** — should be near zero; a growing count means the relay is down:

```sql
SELECT count(*) AS unpublished,
       min(created_at) AS oldest
  FROM outbox WHERE published_at IS NULL;
```

**Unacknowledged receipts, oldest first:**

```sql
SELECT n.type, n.received_at, n.submission_id
  FROM notifications n
 WHERE n.acknowledged_at IS NULL
 ORDER BY n.received_at
 LIMIT 50;
```

**Verify RLS is intact** — expect 14 rows, all with both predicates:

```sql
SELECT tablename, policyname,
       qual IS NOT NULL AS has_using,
       with_check IS NOT NULL AS has_with_check
  FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename;
```

**Verify `FORCE` is on, not merely `ENABLE`:**

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class
 WHERE relname IN ('sellers','invoices','sdi_submissions','correlation_records',
                   'notifications','outbox','api_keys','mcp_keys','webhooks',
                   'webhook_deliveries','transformations','channel_credentials',
                   'idempotency_keys','audit_log');
```

Both columns must be `t` on all fourteen. `relrowsecurity = t` with `relforcerowsecurity = f` means the table owner bypasses the policy — a silent isolation failure.

**Verify the roles:**

```sql
SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit
  FROM pg_roles WHERE rolname LIKE 'passo%' ORDER BY rolname;
```

`passo_app` must be `rolsuper = f` and `rolbypassrls = f`. `passo_quarantine` must be `rolinherit = f`.

**Tables growing without a retention policy:**

```sql
SELECT relname, n_live_tup
  FROM pg_stat_user_tables
 WHERE relname IN ('outbox','webhook_deliveries','idempotency_keys',
                   'quarantined_notifications')
 ORDER BY n_live_tup DESC;
```

None of these four are pruned by the purge job.
