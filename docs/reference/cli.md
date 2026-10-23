# CLI

`passo-cli` is the operator interface. PASSO is API-only, so the CLI is a thin wrapper: everything it does is reachable from the Admin API, and it holds no logic of its own.

Two things it does that the Admin API does not: it inspects and replays **RabbitMQ dead letters**, and it runs the **purge job on demand**.

## Invocation

::: danger `passo-cli` cannot be run directly
`package.json` declares `"bin": { "passo-cli": "src/cli/passo-cli.ts" }` and the file's shebang is a plain `#!/usr/bin/env node` — with **no** `--experimental-strip-types` flag.

Node 22 cannot execute a TypeScript file without that flag, so a linked `passo-cli` fails on the first `import` with a syntax error.

Use one of these instead:

```bash
npm run cli -- audit verify <tenantId>
node --experimental-strip-types src/cli/passo-cli.ts audit verify <tenantId>
```

Inside the stack:

```bash
docker compose exec api node --experimental-strip-types \
  src/cli/passo-cli.ts audit verify <tenantId>
```
:::

A convenience alias:

```bash
passo() {
  docker compose exec -T api node --experimental-strip-types src/cli/passo-cli.ts "$@"
}
passo audit verify 7a3f0c11-...
```

## Environment

The CLI calls `loadConfig()` and `createPool()` like any other role, so it needs the **same environment** as the application:

- `DATABASE_URL` for every command
- `PASSO_ADMIN_KEY` and `PASSO_ENCRYPTION_KEY_*` because `loadConfig` and the key provider validate at boot
- `RABBITMQ_URL` for the `dlq` commands

Running it inside the `api` container is the simplest way to satisfy all of that. Run it from the host and you need a `.env` with a `DATABASE_URL` that resolves from the host — `@postgres:5432` will not.

::: tip Output convention
Machine-readable output goes to **stdout**; human warnings go to **stderr**. So `passo key create ... > key.txt` captures only the key, and the "store this now" warning still appears on your terminal.
:::

## Usage

```
passo-cli <command>

  tenant create <name> <slug> <transmitterCode>
  key create <tenantId> <name>
  key rotate <tenantId> <keyId>
  key revoke <tenantId> <keyId>
  dlq list [queue]
  dlq replay <queue>
  quarantine list
  audit verify <tenantId>
  purge run
```

An unrecognised command prints this and exits non-zero. No arguments prints it and exits zero.

---

## `tenant create`

```bash
passo tenant create "Acme CRM" acme 01234567890
```

```
7a3f0c11-4b2e-4d19-9c33-8e1a2f5b7d90
```

Prints the new tenant id to stdout, and nothing else — so it composes:

```bash
TENANT=$(passo tenant create "Acme CRM" acme 01234567890)
```

::: warning `transmitterCountry` is not settable here
The CLI's INSERT omits the column, so it takes the schema default `IT`. For a non-Italian transmitter use the Admin API, which accepts `transmitterCountry`.
:::

The transmitter code becomes `IdCodice` and, joined with the country, forms the `transmitter_id` that keys `ProgressivoInvio` allocation.

---

## `key create`

```bash
passo key create 7a3f0c11-... production
```

```
passo_live_kJ8xN2pQ7vR3mT9wL5yH1bF6
```
```
store this now — it cannot be retrieved again
```

The key goes to stdout; the warning to stderr.

::: danger Shown exactly once
Stored as a bcrypt hash (cost 12). There is no endpoint or command that returns it again. Capture it now or rotate.
:::

The name defaults to `default` if omitted. The CLI always creates a `live` key with the default scopes (`invoices:write`, `invoices:read`) and no expiry — for a `test` key or an expiring one, use the Admin API.

---

## `key rotate`

```bash
passo key rotate 7a3f0c11-... c4e1b882-...
```

```
passo_live_9mQ4rT7vX2wZ5nB8kL1jH3fD
```
```
old key stays valid for 7 days
```

Issues a new key and sets the old one to `rotating` with a 7-day expiry. Name, environment and scopes are copied; the new key is named `"<old name> (rotated)"`.

The rollover:

1. Rotate; store the new key.
2. Deploy it at your leisure.
3. The old key expires on its own after 7 days.

Both the rotation and the creation are written to the hash-chained audit log.

---

## `key revoke`

```bash
passo key revoke 7a3f0c11-... c4e1b882-...
```

```
revoked immediately — no grace period
```

Nothing on stdout. The next request with that key gets `401 ERR_AUTH_REVOKED`.

::: warning Revoke on compromise; rotate on schedule
Revocation is instant and unconditional. A revoked key still in use produces an outage — which is the intended behaviour when a key has leaked.
:::

---

## `dlq list`

```bash
passo dlq list
```

```
dead-letter queues:
  dlq.transform
  dlq.generate-xml
  dlq.sign
  dlq.submit-sdi
  dlq.pec-parse
  dlq.notification
  dlq.dispatch-webhook
```

::: warning This prints queue *names*, not messages
It enumerates the DLQ naming convention (`q.foo` → `dlq.foo`) by iterating the `QUEUES` constant. It does not connect to inspect depth or contents, and the optional `[queue]` argument in the usage text is not read.

For actual message counts use the RabbitMQ management UI on `RABBITMQ_MGMT_PORT` (default 15672), or:

```bash
docker compose exec rabbitmq rabbitmqctl list_queues name messages | grep dlq
```
:::

Note that five of those queues have no consumer in this build — only `q.submit-sdi` and `q.dispatch-webhook` do. Their DLQs exist and will stay empty. See [Queue topology](/reference/queues).

---

## `dlq replay`

```bash
passo dlq replay dlq.submit-sdi
```

```
replayed 3 message(s)
```

Consumes each message from the named DLQ and republishes it to `passo.invoices` with the routing key rewritten from `dlq.` back to `q.`, and `attempt` reset to `0`.

It consumes for a fixed **2 seconds** and then closes. A large DLQ needs several passes.

::: danger Replay is not a retry override
The retry **guard** still applies downstream. A replayed message for an NS-rejected submission reaches the submit worker, which re-reads the submission's state and returns early — the state is `rejected`, not `queued` or `transmitting`.

That guard is what prevents a replay from sending a duplicate to the tax authority. Do not work around it.
:::

::: warning Diagnose before replaying
A message is in a DLQ because it failed after exhausting its retries. Replaying without fixing the cause produces the same failure and puts it straight back.

Inspect the submission first:

```bash
curl localhost:3000/api/v1/invoices/<id> -H "authorization: Bearer <key>"
```

A `failed` state means it never reached SdI. Check the worker logs for the `ChannelError` and its `code` — `ERR_CHANNEL_AUTH` means bad credentials and replaying will not help until they are fixed.
:::

---

## `quarantine list`

```bash
passo quarantine list
```

```json
[
  {
    "id": "aa11bb22-...",
    "type": "MT",
    "identificativo_sdi": "9931",
    "reason": "receiver-flow notification (MT) — inbound reception is v2",
    "channel": "pec",
    "created_at": "2026-09-01T11:20:00.000Z"
  }
]
```

Unresolved entries only, newest first, capped at 100.

A quarantined notification is an SdI receipt that could not be attributed to a tenant, or one belonging to the v2 inbound-reception flow.

::: tip This reads a metadata-only view
The query targets `quarantine_index`, which deliberately excludes the `raw` column, and runs under the dedicated `passo_quarantine` role.

Listing orphaned receipts is routine; reading a stranger's fiscal payload is not. For the raw XML use the Admin API one row at a time:

```bash
curl localhost:3000/api/v1/admin/quarantine/<id> -H "authorization: Bearer $ADMIN"
```
:::

::: warning Quarantined receipts are never discarded
Over PEC the mailbox is the only copy of a legal receipt. Entries accumulate until an operator resolves them; the purge job does not touch this table.

A growing quarantine is a signal. Two common causes: `CORRELATION_RETENTION_DAYS` is too short for receipts arriving late, or the instance is receiving notifications for submissions it never made.
:::

---

## `audit verify`

```bash
passo audit verify 7a3f0c11-...
```

```json
{"ok":true}
```

Broken:

```json
{"ok":false,"brokenAtId":"4471"}
```

**Exits non-zero on failure**, which is what makes it usable from cron:

```bash
0 3 * * * /usr/local/bin/passo audit verify $TENANT || \
  mail -s "PASSO audit chain broken" ops@example.com
```

The audit log is hash-chained — each row's hash covers the previous row's hash, so deletion and reordering are detectable, not just field edits.

::: danger A broken chain is an incident
The chain does not break by accident. Application code never updates or deletes audit rows.

One expected exception: the purge job deletes rows older than `AUDIT_RETENTION_MONTHS`, which breaks the chain at the retention boundary by design. Verification starts from the first *visible* row and does not treat its `prev_hash` as a failure, so this should not raise a false alarm.

A break anywhere else means someone with database access modified the log. Investigate before anything else.
:::

Verify every tenant:

```bash
for T in $(docker compose exec -T postgres psql -U passo_admin -d passo -tAc \
           "SELECT id FROM tenants"); do
  echo -n "$T "; passo audit verify "$T"
done
```

::: warning Per-tenant verification has a known limit
The chain is global across the instance while `audit_log` is tenant-scoped. This command proves your tenant's rows form an unbroken subsequence — which is what detects a deletion among them — but cannot say anything about other tenants' rows.

Full-instance verification is a direct database task run with elevated privileges. See [Security](/operations/security#the-hash-chained-audit-log).
:::

---

## `purge run`

```bash
passo purge run
```

```json
{
  "payloads": 12,
  "receipts": 5,
  "correlations": 3,
  "auditRows": 0
}
```

Runs the retention job immediately. It **also runs hourly on its own** inside the `worker` role, so this is for forcing a cycle after changing retention settings or verifying behaviour — not something you need to schedule.

What it does, in order:

| Step | Action | Condition |
|---|---|---|
| 1 | Null the XML on `sdi_submissions`, set `purged_at` | `terminal_at IS NOT NULL` |
| 2 | Null the payload on `invoices`, set `purged_at` | Its submission is terminal |
| 3 | Delete acknowledged receipts | `purge_eligible_at < now()` |
| 4 | Delete expired correlation records | `expires_at < now() AND terminal_at IS NOT NULL` |
| 5 | Delete old audit rows | Older than `AUDIT_RETENTION_MONTHS` |

Every payload purge is itself written to the audit log with `actor: 'purge-job'`.

::: danger Purging is irreversible
Once step 1 runs, the XML is gone. `GET /invoices/{id}/xml` and `/rendered` return `410 Gone` from then on.

**Fetch what you need before a terminal receipt arrives.** PASSO is a relay, not an archive — your CRM is the system of record. See [What PASSO is not](/guide/scope).
:::

::: tip An unacknowledged receipt is never purged, regardless of age
Enforced by a database CHECK constraint, not only by application code:

```sql
CHECK (purge_eligible_at IS NULL OR acknowledged_at IS NOT NULL)
```

Age alone is never sufficient. A receipt your CRM has not confirmed survives indefinitely.
:::

It runs under `SET LOCAL ROLE passo_purge` — a dedicated role granted exactly the five tables it prunes, because retention operates across every tenant and cannot run under a single `app.tenant_id`.

---

## What the CLI does not do

Reachable only through the [Admin API](/api/admin):

| Operation | Endpoint |
|---|---|
| List tenants, keys, sellers, channels | `GET /admin/…` |
| Create a seller | `POST /admin/tenants/{id}/sellers` |
| Configure a channel | `PUT /admin/tenants/{id}/channels/{channel}` |
| Register a webhook | `POST /admin/tenants/{id}/webhooks` |
| Save a transformation | `POST /admin/tenants/{id}/transformations` |
| Read a quarantined raw payload | `GET /admin/quarantine/{id}` |
| Create a `test` or expiring key | `POST /admin/tenants/{id}/api-keys` |
| Set a non-`IT` transmitter country | `POST /admin/tenants` |

There is no command to submit an invoice. Submission is a tenant-authenticated API operation, deliberately.

## Operator recipes

**Provision a tenant with a key:**

```bash
TENANT=$(passo tenant create "Acme CRM" acme 01234567890)
KEY=$(passo key create "$TENANT" production)
echo "tenant=$TENANT"
echo "key=$KEY"   # store it now
```

**Nightly audit check across all tenants:**

```bash
#!/usr/bin/env bash
set -euo pipefail
FAILED=0
for T in $(docker compose exec -T postgres psql -U passo_admin -d passo -tAc \
           "SELECT id FROM tenants WHERE status = 'active'"); do
  if ! passo audit verify "$T" | grep -q '"ok":true'; then
    echo "AUDIT CHAIN BROKEN: $T" >&2
    FAILED=1
  fi
done
exit $FAILED
```

**Check for a growing quarantine:**

```bash
COUNT=$(passo quarantine list | jq 'length')
[ "$COUNT" -gt 0 ] && echo "WARNING: $COUNT quarantined notifications"
```

**Rotate every active key for a tenant:**

```bash
curl -s localhost:3000/api/v1/admin/tenants/$TENANT/api-keys \
  -H "authorization: Bearer $ADMIN" \
  | jq -r '.data[] | select(.status=="active") | .id' \
  | while read -r KEY_ID; do
      echo "rotating $KEY_ID"
      passo key rotate "$TENANT" "$KEY_ID"
    done
```

Each old key stays valid for 7 days, so this is safe to run before deploying the new keys.
