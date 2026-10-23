# Multi-tenancy

One PASSO instance serves many CRMs. A **tenant** is one CRM integration: its own API keys, sellers, webhooks, transformations and channel configuration, isolated at the database level rather than by application convention.

## The CRM is the tenant

The unit of isolation is the integrating system, not the taxpayer. A single tenant can hold many **sellers** — the legal entities that actually issue invoices — because one CRM typically bills on behalf of several companies.

That split matters for the transmission identity. `IdTrasmittente` (the transmitter) comes from the *tenant*:

```
tenants.transmitter_country || tenants.transmitter_code   →  transmitter_id
```

while `CedentePrestatore` (the seller) comes from the referenced `sellers` row. `ProgressivoInvio` is unique per transmitter, so the counter is keyed on the tenant's transmitter id, not on the seller.

```bash
curl -X POST localhost:3000/api/v1/admin/tenants \
  -H "authorization: Bearer $PASSO_ADMIN_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"Acme CRM","slug":"acme","transmitterCode":"01234567890"}'
```

`transmitterCountry` defaults to `IT`.

## Tenant identity comes from the key, never from the request

```ts
// src/api/middleware/auth.ts
const k = await resolveApiKey(db, token);
req.tenantId = k.tenantId;
```

There is no `tenantId` path parameter, query parameter or body field on any tenant-facing route. The only thing that determines which tenant a request acts as is the bearer token it presented. A caller cannot ask to be someone else, because there is nowhere to ask.

Every tenant-scoped query then runs through `withTenant`:

```ts
await c.query('BEGIN');
await c.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
// ... queries ...
await c.query('COMMIT');
```

`set_config(..., true)` is transaction-local, so the setting evaporates on COMMIT or ROLLBACK and cannot leak to the next borrower of that pooled connection.

## Row-level security

Fourteen tables are tenant-scoped and carry RLS:

`sellers` · `invoices` · `sdi_submissions` · `correlation_records` · `notifications` · `outbox` · `api_keys` · `mcp_keys` · `webhooks` · `webhook_deliveries` · `transformations` · `channel_credentials` · `idempotency_keys` · `audit_log`

Each gets the same treatment:

```sql
ALTER TABLE sellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sellers FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sellers
  USING      (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
```

Three details in that statement are each load-bearing.

### `FORCE`, not just `ENABLE`

`ENABLE ROW LEVEL SECURITY` does not apply the policy to the table's **owner**. The owner is exactly the role a migration runs as, and in a small deployment it is tempting to run the application under it too. `FORCE ROW LEVEL SECURITY` removes that exemption, so the policy applies to everyone who is not explicitly `BYPASSRLS`.

### `WITH CHECK`, not just `USING`

`USING` filters rows that a statement can *see*. It says nothing about rows a statement can *write*.

With `USING` alone, tenant B can happily run:

```sql
INSERT INTO invoices (tenant_id, ...) VALUES ('<tenant-A-uuid>', ...);
```

The insert succeeds. B then cannot read the row back — but the row exists, under A's tenant, written by B. `WITH CHECK` applies the same predicate to `INSERT` and `UPDATE`, so a row that would land outside the current tenant is rejected outright.

### `NULLIF(..., '')` — failing closed, cleanly

::: danger The unset-context trap
With no `app.tenant_id` set, `current_setting('app.tenant_id', true)` returns the **empty string**, not NULL. And `''::uuid` does not yield NULL — it **raises** `invalid input syntax for type uuid`.

A raised error is not the same as fail-closed. It surfaces as a `500`, and any code path that catches-and-continues could misread it as an infrastructure blip rather than a missing security context.

`NULLIF(current_setting('app.tenant_id', true), '')::uuid` turns the unset case into NULL. `tenant_id = NULL` evaluates to NULL, which is not true, so the row is filtered. Zero rows, no exception, no ambiguity.
:::

This was fixed in migration `1000000000001_rls-nullsafe`. The behaviour to rely on is: **a forgotten `SET LOCAL` yields an empty result set, never an error and never a leak.**

You can see this yourself — a bare query outside `withTenant` returns nothing:

```sql
-- No app.tenant_id set:
SELECT count(*) FROM invoices;   -- 0, regardless of how many rows exist
```

## RLS protects rows, not references

Here is the gap RLS alone leaves, and it is subtle enough that it shipped before it was caught.

A plain foreign key says only that the parent row exists:

```sql
invoices.seller_id REFERENCES sellers(id)
```

Now tenant B submits an invoice referencing **tenant A's** seller id. Check what each mechanism sees:

- RLS on `invoices`: satisfied. The new row's `tenant_id` is B's, which is what the `WITH CHECK` predicate tests.
- The foreign key: satisfied. A row with that id exists in `sellers`.
- Reality: B has just issued an invoice under A's legal fiscal identity.

RLS filters *rows in the table being written*. It has no opinion about what those rows *point at*.

### The fix: composite `(tenant_id, id)` foreign keys

Migration `1000000000006_composite-tenant-fks` adds a composite unique key to each parent and rewrites the child constraints:

```sql
ALTER TABLE sellers ADD CONSTRAINT sellers_tenant_id_uk UNIQUE (tenant_id, id);

ALTER TABLE invoices
  ADD CONSTRAINT invoices_seller_id_tenant_fkey
  FOREIGN KEY (tenant_id, seller_id) REFERENCES sellers (tenant_id, id)
  ON DELETE RESTRICT;
```

Four relationships are protected this way:

| Child | Column | Parent |
|---|---|---|
| `invoices` | `seller_id` | `sellers` |
| `sdi_submissions` | `invoice_id` | `invoices` |
| `notifications` | `submission_id` | `sdi_submissions` |
| `webhook_deliveries` | `webhook_id` | `webhooks` |

The database now makes a cross-tenant reference *impossible*, rather than relying on every future query — including ones nobody has written yet — remembering to check.

::: tip Why this is worth the extra unique index
The alternative is a `WHERE seller.tenant_id = $tenantId` clause in every query that touches a seller. That works right up until someone writes the one query that forgets, and there is no test that can prove no such query will ever be written. A constraint has no such failure mode.
:::

## The bypass roles

RLS is only meaningful if the application role is subject to it. `passo_app` is created `NOSUPERUSER NOBYPASSRLS` — the policy applies to it, always.

But some operations genuinely cannot know their tenant in advance, because determining the tenant *is what they are for*. Each gets a dedicated role with grants narrowed to exactly what that one operation needs.

| Role | Operation | Grants |
|---|---|---|
| `passo_auth` | Resolve an API key to a tenant | `SELECT` on the `api_key_auth` view; `UPDATE (last_used_at)` on `api_keys` |
| `passo_router` | Route an incoming receipt to a tenant | `SELECT` on the `correlation_routing` view |
| `passo_relay` | Drain the outbox; enumerate PEC tenants | `SELECT, UPDATE` on `outbox`; `SELECT` on the `active_channels` view |
| `passo_purge` | Prune expired data across tenants | `SELECT, UPDATE` on `sdi_submissions`, `invoices`; `SELECT, DELETE` on `notifications`, `correlation_records`, `audit_log`; `INSERT` on `audit_log` |
| `passo_quarantine` | Read receipts with no determinable tenant | `SELECT, UPDATE` on `quarantined_notifications`; `SELECT` on the `quarantine_index` view |

The first four are `BYPASSRLS`. `passo_quarantine` is different — it is `NOINHERIT` and reaches a table that has **no `tenant_id` column and no RLS policy at all**, so containment there comes from grants rather than from policies. See below.

They are assumed for one transaction and dropped at COMMIT:

```ts
await c.query('BEGIN');
await c.query('SET LOCAL ROLE passo_router');
// ... one lookup ...
await c.query('COMMIT');
```

### Why each one is unavoidable

**`passo_auth` — authentication is the tenant lookup.**
A request arrives with `Bearer passo_live_…`. To set `app.tenant_id` you need the tenant. To get the tenant you must read `api_keys`. But `api_keys` is tenant-scoped, so reading it requires `app.tenant_id`. That is a circular dependency, and there is no order of operations that resolves it.

The bypass is narrowed by a view rather than by trust:

```sql
CREATE VIEW api_key_auth AS
  SELECT k.id, k.tenant_id, k.key_hash, k.key_prefix, k.scopes,
         k.status, k.expires_at, k.revoked_at
    FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
   WHERE t.status = 'active';
```

Eight columns and nothing else. The join on `tenants.status` means a suspended tenant's keys stop resolving at the database layer, not in an `if` statement somebody could later delete.

**`passo_router` — a receipt does not know who it belongs to.**
An `RC` arriving from SdI carries an `IdentificativoSdI` and a filename. It carries no tenant id, and there is no header to add one to: the sender is the Italian tax authority. The correlation record is the only thing that maps that identifier to a tenant, and reading it is what determines the tenant.

The view is six columns wide by design:

```sql
CREATE VIEW correlation_routing AS
  SELECT tenant_id, submission_id, crm_invoice_ref,
         progressivo_invio, identificativo_sdi, pec_message_id, status
  FROM correlation_records;
```

No amounts. No party names. No XML. Compromising `passo_router` yields a list of opaque identifiers and statuses — not invoices.

**`passo_relay` — the outbox spans every tenant.**
The relay drains rows whose `tenant_id` differs row by row. Setting a single `app.tenant_id` for the batch is nonsensical; setting one per row would mean one transaction per message. The grant is `outbox` alone — no invoices, no credentials, no audit log. Each published message carries its `tenant_id`, and the consumer sets the RLS context from it.

The same role also reads `active_channels` for the PEC poller, which has the same shape of problem:

```sql
CREATE VIEW active_channels AS
  SELECT tenant_id, channel FROM channel_credentials WHERE active = true;
```

::: warning This one failed silently before it was fixed
The poller must ask "which tenants have an active PEC channel?" *before* it can know a tenant — the answer is the list it iterates. Reading `channel_credentials` directly under RLS with no context returned zero rows, so the poller looped forever over an empty list. No receipts, no state transitions, **and no error**. Migration `1000000000008_channel-enumeration` added the two-column view.
:::

**`passo_purge` — retention runs on a schedule, across everyone.**
The hourly purge deletes expired data instance-wide. Iterating tenants one at a time would work but turns one statement into N transactions and still needs a way to enumerate tenants. Its grants are scoped to precisely the five tables it prunes, and it can only `INSERT` into `audit_log` — never `UPDATE` it.

**`passo_quarantine` — a receipt with no tenant cannot be scoped by tenant.**
This is the inverse of the others. The rest bypass RLS to *find* a tenant; this one exists because for these rows there **is** no tenant to find.

A quarantined notification is a receipt that matched no correlation record. `quarantined_notifications` therefore has no `tenant_id` column, no RLS policy, and no possible policy — there is nothing to scope by. That is correct by design, and it made the table a cross-tenant hole: `passo_app`, the tenant-scoped application role, held full `SELECT` on it and could read every tenant's raw fiscal receipt regardless of tenant context.

Since RLS cannot help, containment comes from grants:

```sql
REVOKE ALL   ON quarantined_notifications FROM passo_app;
GRANT INSERT ON quarantined_notifications TO   passo_app;
GRANT SELECT, UPDATE ON quarantined_notifications TO passo_quarantine;
GRANT passo_quarantine TO passo_app;
```

`passo_app` keeps `INSERT` and loses `SELECT`. The ingest path must still be able to quarantine an unmatched receipt — **writing is not reading**.

The role is `NOINHERIT`, so `passo_app` holding membership does not silently acquire its privileges; the role must be assumed deliberately with `SET LOCAL ROLE passo_quarantine`, which is what `withQuarantineRole` does.

And a metadata-only view carries the routine case:

```sql
CREATE VIEW quarantine_index AS
  SELECT id, reason, type, identificativo_sdi, filename, channel,
         resolved_at, resolved_by, created_at
    FROM quarantined_notifications;
```

No `raw`. Listing orphaned receipts is a routine operator action; reading a stranger's fiscal payload is not, and the two do not share a query. See [Admin API](/api/admin#quarantine).

### The shape of the pattern

Every one of these follows the same three rules:

1. **It exists because the tenant is genuinely unknown or unknowable**, not because scoping was inconvenient.
2. **It reads a narrow view**, not a base table — so the blast radius of a compromised role is a fixed, auditable column list.
3. **It is assumed for one transaction** with `SET LOCAL ROLE` and released at COMMIT.

If you add a sixth, hold it to the same three.

## Cross-tenant misses return 404, not 403

Fetching another tenant's submission id returns `404 ERR_NOT_FOUND`. RLS filters the row, the query returns nothing, and the route raises a not-found.

This is also the correct answer. A `403` would confirm that the resource exists somewhere in the system — an existence oracle that lets an attacker enumerate valid submission ids across the whole instance. `404` says only "not yours, and I am not telling you whether it is anyone's."

The one status that *does* disclose existence is `410 Gone`, returned after purge — and it discloses only that a submission you already own once had a payload. See [Errors](/api/errors).

## Auditing under tenancy

`audit_log` is tenant-scoped and hash-chained. Because the chain is global across the instance while your view of the table is filtered, `verifyAuditChain(tenantId)` proves that *your* rows form an unbroken subsequence — which is what detects a deletion among them. It cannot prove anything about rows belonging to other tenants, which by design you cannot see. Full-instance verification is an operator task run with elevated privileges. See [Security](/operations/security).
