# Backup and Restore

Postgres holds the only irreplaceable state in a PASSO deployment. Everything else can be rebuilt.

::: danger Back up the encryption keys too
A database backup without key material restores **unreadable ciphertext**.

Invoice payloads, generated XML, notification bodies, webhook secrets and channel credentials are all AES-256-GCM encrypted, and every row records only the key *version* — never the key. Restore the database without `PASSO_ENCRYPTION_KEY_V1` and you have rows you can count, join and report on, and cannot decrypt. There is no recovery.

The keys are not in the database. They are in the environment, or in the file named by `PASSO_KEY_FILE`, and they must be backed up separately, on a different schedule, to a different place.
:::

## What is irreplaceable, and what is not

| Component | Irreplaceable | Why |
|---|---|---|
| **Postgres** | **yes** | Invoices, submissions, correlation records, receipts, keys metadata, credentials, the audit chain |
| **Encryption keys** | **yes** | Without them the database is noise |
| RabbitMQ | mostly no | Transport. Unpublished work lives in the outbox |
| Redis | no | Rate-limit counters. Rebuilds itself in 60 seconds |

### Why RabbitMQ is *mostly* reconstructible

The transactional outbox is what makes this true. An invoice and its job are written in one Postgres transaction; the relay publishes from the outbox afterwards. So:

- A message not yet published is still an unpublished outbox row. It republishes on the next tick.
- A message consumed but not acked is redelivered by the broker.
- The queue topology is asserted at boot by `connectBroker` — exchanges, queues, DLQs and bindings are all recreated automatically.

::: warning The gap: rows already marked `published_at`
Once the relay publishes a message it sets `published_at`, and the outbox never looks at that row again. If RabbitMQ then loses the message — a wiped volume, a `docker compose down -v`, a broker rebuilt from scratch — **nothing republishes it**.

Those submissions sit in `queued` or `transmitting` forever. They are not lost (the rows are all in Postgres) but they will not progress on their own.

After any RabbitMQ data loss, find them:

```sql
SELECT s.id, s.state, s.created_at, i.invoice_number
  FROM sdi_submissions s JOIN invoices i ON i.id = s.invoice_id
 WHERE s.state IN ('queued', 'transmitting')
   AND s.created_at < now() - interval '15 minutes'
 ORDER BY s.created_at;
```

Then re-drive each one through `POST /api/v1/invoices/{id}/retry`, which is safe precisely because SdI never accepted them. Anything already terminal needs nothing.

Backing up the RabbitMQ volume is therefore optional but cheap insurance. Redis genuinely is not worth backing up.
:::

## What to back up

### 1. Postgres

```bash
docker compose exec -T postgres \
  pg_dump -U passo_admin -d passo --format=custom --compress=9 \
  > passo-$(date +%Y%m%d-%H%M%S).dump
```

`--format=custom` gives you selective restore and parallel restore. Plain SQL is fine too, just larger and slower.

::: danger `pg_dump` does not include roles
This is the trap that turns a successful-looking restore into a broken system.

PASSO relies on six database roles — `passo_app`, four narrowly-granted `BYPASSRLS` roles, and the `NOINHERIT` `passo_quarantine`. `pg_dump` dumps a *database*; roles are **cluster-level** objects and are not in it.

Restore a `pg_dump` into a fresh cluster and:

- **Authentication fails** — `passo_auth` does not exist, so `SET LOCAL ROLE passo_auth` raises and every API request 500s.
- **Receipt routing fails** — no `passo_router`, so no incoming notification can be matched to a tenant.
- **The relay stops** — no `passo_relay`, so the outbox never drains and no invoice is ever transmitted.
- **Purge stops** — no `passo_purge`.
- **Quarantine becomes unreadable** — no `passo_quarantine`, so an operator cannot trace an orphaned receipt through the Admin API or the CLI.

Dump the globals too, always:

```bash
docker compose exec -T postgres \
  pg_dumpall -U passo_admin --globals-only \
  > passo-globals-$(date +%Y%m%d).sql
```

Or re-run the provisioning path on the restored cluster, which recreates the roles from `migrations/0999999999999_bootstrap-roles.cjs`:

```bash
docker compose run --rm migrate
```

Note that `passo_app` is created `NOLOGIN` in the migration and given its password by the provisioning script — so the globals dump also carries the password you are currently using. Treat that file as a secret.
:::

### 2. The encryption keys

The keys live in `.env` or in `PASSO_KEY_FILE`. Back them up **separately from the database**, encrypted, with different access controls.

```bash
# Extract just the key material
grep -E '^PASSO_ENCRYPTION_KEY' .env > passo-keys-$(date +%Y%m%d).env
gpg --symmetric --cipher-algo AES256 passo-keys-$(date +%Y%m%d).env
shred -u passo-keys-$(date +%Y%m%d).env
```

::: warning Separate storage is the whole point
Keys stored alongside the database dump mean one compromised backup location yields both ciphertext and the key to read it — which is the same as storing plaintext.

Different location, different credentials, different retention.
:::

**Back up every version you have ever used, not just the active one.** Rows encrypted under `v1` still decrypt under `v1` after `v2` becomes active, and there is no re-encryption command that migrates them forward. Discarding `v1` because it is "retired" makes every row still bearing that version permanently unreadable. See [Security](/operations/security#rotation).

### 3. Configuration

`.env` in full, `docker-compose.yml`, and any local customisation. Not irreplaceable, but recreating a working `.env` under pressure is not how you want to spend an outage.

## A backup script

```bash
#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR=/var/backups/passo
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"

# 1. Database
docker compose exec -T postgres \
  pg_dump -U passo_admin -d passo --format=custom --compress=9 \
  > "$BACKUP_DIR/passo-$STAMP.dump"

# 2. Cluster globals — roles. Without these the restore does not work.
docker compose exec -T postgres \
  pg_dumpall -U passo_admin --globals-only \
  > "$BACKUP_DIR/globals-$STAMP.sql"

# 3. Verify the dump is readable before trusting it
pg_restore --list "$BACKUP_DIR/passo-$STAMP.dump" > /dev/null

# 4. Record what the backup expects to be decryptable with
grep -oE '^PASSO_ENCRYPTION_KEY_[A-Z0-9]+' .env \
  | sort > "$BACKUP_DIR/keys-required-$STAMP.txt"

echo "backup complete: $STAMP"
```

Step 4 is small and worth having. It records *which key versions* the deployment held at backup time, so a restorer can confirm they have them all before starting — rather than discovering a missing version halfway through verification.

Key material itself is deliberately **not** in this script. It belongs on a different path, with different access controls, at a different frequency.

## Restore

### 1. Stop the application

```bash
docker compose stop api worker relay
```

Leave Postgres running. Restoring underneath live writers produces a database that is neither the backup nor the current state.

### 2. Restore the roles first

```bash
docker compose exec -T postgres \
  psql -U passo_admin -d postgres < globals-20260901-120000.sql
```

Before the database, so grants in the dump have roles to attach to. Errors about roles that already exist are expected and harmless.

### 3. Restore the database

Into a clean database:

```bash
docker compose exec -T postgres psql -U passo_admin -d postgres \
  -c "DROP DATABASE IF EXISTS passo;" -c "CREATE DATABASE passo OWNER passo_admin;"

docker compose exec -T postgres \
  pg_restore -U passo_admin -d passo --no-owner --role=passo_admin \
  < passo-20260901-120000.dump
```

### 4. Restore the keys

Put every key version back into `.env` or the key file, and confirm `PASSO_ENCRYPTION_KEY_ACTIVE` names one that is present. `EnvKeyProvider` refuses to start if the active version has no matching key — a useful early failure.

### 5. Start and verify

```bash
docker compose up -d
docker compose logs -f api
```

## Verifying a restore

A restore that starts is not a restore that worked. Run all five.

### 1. Row counts

```sql
SELECT 'tenants' t, count(*) FROM tenants
UNION ALL SELECT 'sellers', count(*) FROM sellers
UNION ALL SELECT 'invoices', count(*) FROM invoices
UNION ALL SELECT 'sdi_submissions', count(*) FROM sdi_submissions
UNION ALL SELECT 'correlation_records', count(*) FROM correlation_records
UNION ALL SELECT 'notifications', count(*) FROM notifications
UNION ALL SELECT 'api_keys', count(*) FROM api_keys
UNION ALL SELECT 'webhooks', count(*) FROM webhooks
UNION ALL SELECT 'channel_credentials', count(*) FROM channel_credentials
UNION ALL SELECT 'audit_log', count(*) FROM audit_log
UNION ALL SELECT 'outbox', count(*) FROM outbox
ORDER BY 1;
```

Compare against the same query taken before the backup. Keep that output *with* the backup — a count you cannot compare to anything proves nothing.

Run this as a superuser or with `SET LOCAL ROLE passo_purge`; under `passo_app` with no tenant context, RLS returns zero for every tenant-scoped table. That is correct behaviour, and it is also a useful check in its own right — see below.

### 2. The audit chain

```bash
for T in $(docker compose exec -T postgres psql -U passo_admin -d passo -tAc \
           "SELECT id FROM tenants"); do
  echo -n "$T: "
  docker compose exec -T api node --experimental-strip-types \
    src/cli/passo-cli.ts audit verify "$T"
done
```

Expect `{"ok":true}` for every tenant.

::: warning A break here can mean two different things
Either the backup captured a genuinely tampered log — investigate immediately — or the restore was **partial**: a filtered dump, a failed `pg_restore` that skipped rows, or a table-level restore that dropped some audit entries.

Both are serious. A broken chain after a restore means either your log was tampered with, or your restore is incomplete and you should not trust the rest of the data either.

One expected break: if the purge job has run, rows older than `AUDIT_RETENTION_MONTHS` are gone and the chain breaks at that boundary by design. Verification starts from the first *visible* row and does not treat its `prev_hash` as a failure, so this should not produce a false alarm — but it is worth knowing.
:::

### 3. RLS policies survived

Policies are part of the schema and `pg_dump` includes them — but a `--data-only` restore, a table-by-table recovery or a hand-built schema will not have them, and the result is a system with **no tenant isolation** that otherwise behaves perfectly.

```sql
SELECT tablename, policyname,
       qual        IS NOT NULL AS has_using,
       with_check  IS NOT NULL AS has_with_check
  FROM pg_policies
 WHERE schemaname = 'public'
 ORDER BY tablename;
```

Expect **14 rows**, all named `tenant_isolation`, all with `has_using` and `has_with_check` true.

Confirm `FORCE` is on, not merely `ENABLE`:

```sql
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class
 WHERE relname IN ('sellers','invoices','sdi_submissions','correlation_records',
                   'notifications','outbox','api_keys','mcp_keys','webhooks',
                   'webhook_deliveries','transformations','channel_credentials',
                   'idempotency_keys','audit_log')
 ORDER BY relname;
```

Both columns must be `t` on all fourteen. `relrowsecurity = t` with `relforcerowsecurity = f` means the table owner bypasses the policy — a silent isolation failure.

Then test it behaviourally, which is what actually matters:

```sql
SET ROLE passo_app;
SELECT count(*) FROM invoices;                       -- must be 0
SELECT set_config('app.tenant_id', '<a-real-uuid>', false);
SELECT count(*) FROM invoices;                       -- must be > 0
RESET ROLE;
```

The first count returning zero **and not raising an error** is the fail-closed behaviour the `NULLIF` policy guarantees. A count greater than zero means RLS is not applied and the restore must not go into service.

### 4. The roles exist with the right attributes

```sql
SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolinherit
  FROM pg_roles
 WHERE rolname LIKE 'passo%'
 ORDER BY rolname;
```

Expect **six rows**:

| Role | `rolsuper` | `rolbypassrls` | `rolinherit` |
|---|---|---|---|
| `passo_app` | **f** | **f** | t |
| `passo_auth` | f | t | t |
| `passo_purge` | f | t | t |
| `passo_quarantine` | f | **f** | **f** |
| `passo_relay` | f | t | t |
| `passo_router` | f | t | t |

`passo_quarantine` is the odd one: not `BYPASSRLS` (it reaches a table with no RLS at all) and `NOINHERIT`, so membership does not silently confer its privileges.

::: danger `passo_app` with `rolbypassrls = t` is a critical failure
It means the application role bypasses row-level security, and every tenant can read every other tenant's data. The system will work flawlessly and leak everything.

Fix it before starting the application:

```sql
ALTER ROLE passo_app NOBYPASSRLS NOSUPERUSER;
```
:::

Check the views the bypass roles depend on exist and are granted:

```sql
SELECT table_name, grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_name IN ('api_key_auth','correlation_routing',
                      'active_channels','quarantine_index')
 ORDER BY table_name, grantee;
```

All four must be present. `correlation_routing` missing its grant is the specific failure that migration `1000000000007_router-grants` exists to prevent — during development it had been applied by hand, and a rebuilt database silently lost it.

Check the quarantine containment survived too, since it is expressed purely as grants:

```sql
SELECT grantee, privilege_type
  FROM information_schema.role_table_grants
 WHERE table_name = 'quarantined_notifications'
 ORDER BY grantee, privilege_type;
```

`passo_app` must hold **`INSERT` only**. If it has `SELECT`, migration 009 did not apply and every tenant-scoped path can read unattributable fiscal receipts.

### 5. Decryption actually works

The check that proves you restored the keys, not just the database:

```bash
# Pick a submission that still has its XML
docker compose exec -T postgres psql -U passo_admin -d passo -tAc \
  "SELECT id FROM sdi_submissions WHERE xml_encrypted IS NOT NULL LIMIT 1"

curl -s localhost:3000/api/v1/invoices/<that-id>/xml \
  -H "authorization: Bearer <a-tenant-key>" | head -3
```

FatturaPA XML means keys, ciphertext and AAD binding all line up.

A decryption error means either a missing key version or a mismatched tenant binding. If every submission is already purged, test with a channel config instead — `GET /admin/tenants/{id}/channels` reads and decrypts on the way to reporting `configured: true`.

::: tip Run this check even when nothing looks wrong
Every other verification passes on a database restored without keys. Row counts are right, the audit chain verifies, RLS is intact, the API answers. The failure only appears when something tries to *read* an encrypted column — which may be days later, on a receipt for an invoice you can no longer produce the XML for.
:::

## The restore drill

An untested backup has never been shown to work. Run this quarterly, on a machine that is not production.

```bash
# 1. Fresh stack on isolated ports
git clone <your-repo> /tmp/passo-drill && cd /tmp/passo-drill
cp /path/to/production/.env .env
sed -i 's/^PASSO_PORT=.*/PASSO_PORT=3999/;
        s/^POSTGRES_PORT=.*/POSTGRES_PORT=15999/;
        s/^RABBITMQ_PORT=.*/RABBITMQ_PORT=15998/;
        s/^RABBITMQ_MGMT_PORT=.*/RABBITMQ_MGMT_PORT=15997/;
        s/^REDIS_PORT=.*/REDIS_PORT=15996/' .env

docker compose up -d postgres
sleep 10

# 2. Restore
docker compose exec -T postgres psql -U passo_admin -d postgres < globals-latest.sql
docker compose exec -T postgres psql -U passo_admin -d postgres \
  -c "DROP DATABASE IF EXISTS passo;" -c "CREATE DATABASE passo OWNER passo_admin;"
docker compose exec -T postgres pg_restore -U passo_admin -d passo --no-owner < passo-latest.dump

# 3. Start and run all five verifications
docker compose up -d
# ... row counts, audit verify, pg_policies, pg_roles, decryption ...

# 4. Tear down completely
docker compose down -v && rm -rf /tmp/passo-drill
```

Record how long it took. "We can restore" and "we can restore in 40 minutes" are different statements, and only the second one is a recovery objective.

::: warning Do not point a drill restore at live credentials
A restored database contains real channel credentials. Start `postgres` alone, or with `worker` and `relay` stopped — a drill stack that starts the worker will begin polling a real PEC mailbox and marking real messages as read, or transmitting queued invoices to SdI a second time.

The commands above start `postgres` first for exactly this reason. If you do bring the full stack up, blank `channel_credentials` first:

```sql
UPDATE channel_credentials SET active = false;
```
:::

## Backups are operational continuity, not legal retention

::: danger PASSO keeps no invoice archive
Payloads and generated XML are **purged** once a terminal receipt arrives. What remains is a correlation record of identifiers and status.

So a PASSO backup contains: tenant and seller configuration, in-flight invoices, correlation records for the retention window, unpurged receipts, and the audit log. It does **not** contain a historical archive of issued invoices, because no such archive exists at any moment.

Restoring from backup gets your **relay** running again. It does not reconstitute an invoice history, because PASSO never held one.
:::

Your legal obligations — the 10-year retention requirement and *conservazione a norma* — are discharged elsewhere:

- **Your CRM is the system of record.** It holds the invoice data.
- **Conservazione is a regulated service.** It requires a designated *Responsabile della conservazione*, a *manuale della conservazione* and qualified time-stamping. PASSO does not perform it and cannot.

Fetch what you need before purge: `GET /invoices/{id}/xml`, `/receipts` and `/rendered` all return `410 Gone` afterwards. See [What PASSO is not](/guide/scope).

## Retention and backup interaction

| Data | Retained until | Controlled by |
|---|---|---|
| Payload + XML | A terminal receipt arrives | Automatic |
| Receipts | Acknowledged + grace window | `RECEIPT_ACK_GRACE_DAYS` (7) |
| Correlation records | ~90 days | `CORRELATION_RETENTION_DAYS` |
| Audit log | ~12 months | `AUDIT_RETENTION_MONTHS` |

::: warning Old backups contain data that has since been purged
A six-month-old backup holds payloads that purge deleted the day after it was taken. If you are subject to data-protection obligations, an unbounded backup retention silently defeats your own deletion policy.

Set a backup retention that matches your data policy, and delete old backups as a matter of routine rather than keeping them "just in case".
:::

An **unacknowledged receipt is never purged, regardless of age** — enforced by a database CHECK constraint, not only by application code:

```sql
CHECK (purge_eligible_at IS NULL OR acknowledged_at IS NOT NULL)
```

So a backup will always contain every receipt your CRM has not yet confirmed.

## Checklist

**Backup**

- [ ] `pg_dump` of the `passo` database
- [ ] `pg_dumpall --globals-only` for the five roles
- [ ] **Every** encryption key version, stored separately and encrypted
- [ ] `.env` and `docker-compose.yml`
- [ ] Row counts recorded alongside the dump
- [ ] Dump readability verified with `pg_restore --list`

**Restore**

- [ ] Application stopped
- [ ] Globals restored **before** the database
- [ ] Every key version present; `PASSO_ENCRYPTION_KEY_ACTIVE` resolves
- [ ] Row counts match
- [ ] `audit verify` returns `ok` for every tenant
- [ ] 14 `tenant_isolation` policies, all with USING and WITH CHECK
- [ ] `relforcerowsecurity = t` on all fourteen tables
- [ ] `passo_app` is `NOBYPASSRLS NOSUPERUSER`
- [ ] All six `passo*` roles present; `passo_quarantine` is `NOINHERIT`
- [ ] The four views exist and are granted
- [ ] `passo_app` holds `INSERT` only on `quarantined_notifications`
- [ ] `GET /invoices/{id}/xml` returns real XML
- [ ] Submissions stranded by RabbitMQ loss identified and re-driven
