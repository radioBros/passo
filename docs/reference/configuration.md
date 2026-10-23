# Configuration

Every environment variable PASSO reads, grouped by concern.

Configuration is validated at boot by `loadConfig()` **before any connection is opened**, so a missing secret fails at startup rather than on the first invoice. All problems are reported at once, not one per restart:

```
Invalid configuration:
  PASSO_ADMIN_KEY: String must contain at least 24 character(s)
  DATABASE_URL: String must contain at least 1 character(s)
```

::: tip Values are never echoed
The error names *which* variables are wrong, never what they were set to. A misconfigured secret must not end up in a log line.
:::

## Two kinds of variable

This distinction matters, because expecting the application to read a Compose-only variable produces settings that appear to have no effect — and in one case, that is exactly what happens.

| Kind | Read by | Effect if wrong |
|---|---|---|
| **Validated** | `src/shared/config.ts` (Zod) | Boot failure with a named problem |
| **Compose / provisioning** | `docker-compose.yml`, the migrate job | Compose refuses to start, or the migration fails |

---

# Validated by `config.ts`

These are parsed and type-checked at boot. A default means the variable is optional.

## Core

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | `development` \| `test` \| `production` | `development` | Environment. Outside `production`, webhook URLs may use plain HTTP |
| `PORT` | int > 0 | `3000` | **The port the process listens on** |
| `PASSO_BASE_URL` | URL | `http://localhost:3000` | Used to build `trackingUrl` in API responses |
| `LOG_LEVEL` | `fatal`…`trace` | `info` | Pino log level. Redaction applies at every level |

::: danger `PORT` is not `PASSO_PORT`
`PORT` is what the **application** binds to. `PASSO_PORT` is what **Compose publishes on the host**, and the application never sees it.

The Compose mapping is `"${PASSO_PORT:-3000}:3000"` — the container side is hardcoded to 3000, as is the healthcheck URL. So:

- Change the **host** port: set `PASSO_PORT`. This is almost always what you want.
- Change the **container** port: set `PORT` *and* edit the compose mapping *and* edit the healthcheck.

Setting `PORT` alone in `.env` breaks the port mapping and the healthcheck at once, and produces a container that looks unhealthy for no visible reason.
:::

`PASSO_BASE_URL` must be the address your CRM can actually reach. It is not used for routing — only for the `trackingUrl` field — so a wrong value produces working invoices with unreachable links recorded against them.

## Database

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | string | **required** | Runtime connection string |
| `DATABASE_POOL_MAX` | int > 0 | `10` | Maximum pooled connections |
| `DATABASE_STATEMENT_TIMEOUT_MS` | int > 0 | `15000` | Per-statement timeout |

`DATABASE_URL` must point at the **least-privilege** role:

```
postgres://passo_app:<password>@postgres:5432/passo
```

::: danger Never point `DATABASE_URL` at the admin role
`passo_app` is `NOSUPERUSER NOBYPASSRLS` — row-level security applies to it, which is what makes tenant isolation real rather than advisory.

Running the application as `passo_admin` makes every tenant able to read every other tenant's data. The system works perfectly and leaks everything.

The admin connection is used by the `migrate` service alone, through `DATABASE_ADMIN_URL`.
:::

**Pool sizing.** `DATABASE_POOL_MAX` is per process. Three roles at 10 each is 30 connections; scaling workers to 4 makes it 60. Postgres 16 defaults to `max_connections = 100`, so a large `--scale` can exhaust it.

**Statement timeout.** 15 seconds is generous for every query PASSO issues. It exists to stop a pathological query holding a connection and a row lock indefinitely — the `ProgressivoInvio` counter is serialised by a row lock, so a stuck statement there blocks every submission for that transmitter.

## RabbitMQ and Redis

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `RABBITMQ_URL` | string | `amqp://localhost` | AMQP connection |
| `REDIS_URL` | string | `redis://localhost:6379` | Rate-limit counters |

Both embed credentials and both are in the log redaction list.

Redis is optional in effect: without it the rate limiter falls back to an in-process counter. The limiter also **fails open** if the store becomes unreachable at runtime — Redis holds nothing whose loss may block an invoice.

## Admin credential

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `PASSO_ADMIN_KEY` | string, min 24 chars | **required** | Bearer token for `/api/v1/admin` |

```bash
openssl rand -base64 32
```

::: danger No default is ever generated
PASSO refuses to start without it. A generated secret ends up in shell history and log files — and worse, produces a working system whose credential nobody deliberately chose.

The key is instance-wide: it grants access to every tenant, cannot be rotated through the API, and cannot be scoped. Rotating it means changing the variable and restarting.
:::

## Encryption

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `PASSO_ENCRYPTION_KEY_ACTIVE` | string | **required** | Version used for new writes |
| `PASSO_ENCRYPTION_KEY_<VERSION>` | base64, 32 bytes | — | Key material, one per version |
| `PASSO_KEY_FILE` | path | — | Alternative source: `version=base64` lines |

Only `PASSO_ENCRYPTION_KEY_ACTIVE` is in the Zod schema. The versioned keys are discovered by `EnvKeyProvider` with a pattern match over the whole environment:

```ts
const m = /^PASSO_ENCRYPTION_KEY_([A-Za-z0-9]+)$/.exec(k);
```

So they are validated by the key provider, not by `loadConfig` — but just as strictly. A key that does not decode to exactly 32 bytes raises `KeyError`. An active version with no matching key raises. A missing active version raises with *"refusing to start rather than store plaintext"*.

```bash
PASSO_ENCRYPTION_KEY_V1=Zm9vYmFyYmF6cXV4...
PASSO_ENCRYPTION_KEY_ACTIVE=v1
```

Version names are case-insensitive and normalised to lowercase.

`PASSO_KEY_FILE` **enforces permissions** — the file must be `0600` or stricter, or startup fails.

::: danger Keep every key version you have ever used
Rows record the version that encrypted them, and there is no re-encryption command. Removing `PASSO_ENCRYPTION_KEY_V1` after rotating to `v2` makes every remaining `v1` row permanently unreadable.

Back the keys up separately from the database. See [Backup & restore](/operations/backup).
:::

## Retention

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `CORRELATION_RETENTION_DAYS` | int > 0 | `90` | How long a correlation record survives |
| `AUDIT_RETENTION_MONTHS` | int > 0 | `12` | Audit log pruning |
| `RECEIPT_ACK_GRACE_DAYS` | int > 0 | `7` | Grace window after acknowledgement |

**`CORRELATION_RETENTION_DAYS`** is the window in which a late receipt can still be routed to a tenant. Past it, an arriving notification lands in quarantine with `no correlation record matched`.

::: warning Note the hardcoded 90 days
`submitInvoice` inserts correlation records with a literal `now() + interval '90 days'`, not with `CORRELATION_RETENTION_DAYS`. The variable is validated and available, but the insert does not read it.

Changing it does not change the expiry of newly-created records in this build.
:::

**`RECEIPT_ACK_GRACE_DAYS`** is applied when you call `POST /invoices/{id}/ack` — the receipt becomes purge-eligible that many days later. This one *is* read from config.

An **unacknowledged receipt is never purged, regardless of age**, enforced by a CHECK constraint:

```sql
CHECK (purge_eligible_at IS NULL OR acknowledged_at IS NOT NULL)
```

**`AUDIT_RETENTION_MONTHS`** is operational forensics, not a tax archive. Pruning breaks the hash chain at the retention boundary by design.

## API behaviour

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `SYNC_MAX_WAIT_MS` | int > 0, max 120000 | `120000` | Ceiling for sync mode |

The effective wait is `min(syncTimeoutMs, SYNC_MAX_WAIT_MS)` — a caller can ask for less, never more. The Zod schema caps the variable itself at 120 s, so a larger value is a boot failure.

Sync mode resolves on the `transmitted` (AT) milestone only. It never waits for RC, MC, DT or NE — MC delivery retry runs for days, so no HTTP timeout can represent final delivery.

## HTTP hardening

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `PASSO_CORS_ORIGINS` | comma-separated | `""` (off) | CORS allowlist |
| `PASSO_CORS_CREDENTIALS` | `true` \| `false` | `false` | Whether CORS allows credentials |
| `PASSO_HSTS_MAX_AGE` | int ≥ 0 | `31536000` | HSTS max-age in seconds; `0` disables |

::: tip These three are not in `.env.example` yet
They are read and validated by `config.ts`, but `.env.example` does not list them. All three have safe defaults — CORS off, HSTS one year — so an untouched `.env` behaves correctly; you simply will not find them by reading the example file.
:::

**CORS is off by default** — empty means no CORS headers are emitted at all. PASSO is a server-to-server relay, and a browser origin has no business holding a CRM's API key.

```bash
PASSO_CORS_ORIGINS=https://app.example.com,https://admin.example.com
```

::: danger The wildcard-plus-credentials pair is refused at boot
```
PASSO_CORS_ORIGINS=*
PASSO_CORS_CREDENTIALS=true
```

Browsers reject `Access-Control-Allow-Origin: *` together with credentials — universally, with no exceptions. An operator who sets this pair believes cross-origin authenticated requests work, and they cannot.

`loadConfig` fails at startup with an explicit message rather than letting the discovery happen at the first browser request:

```
PASSO_CORS_ORIGINS: wildcard "*" cannot be combined with PASSO_CORS_CREDENTIALS=true
— browsers reject that pair. List explicit origins instead.
```
:::

**`PASSO_HSTS_MAX_AGE`** defaults to one year with `includeSubDomains`. Set it to `0` for plain-HTTP local development, where the header would pin your browser to a scheme the dev stack does not serve — an annoying condition to clear.

## Rendering

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `PASSO_XSD_DIR` | path | `assets/xsd` | Bundled AdE schemas |
| `PASSO_XSL_DIR` | path | `assets/xsl` | Bundled AdE stylesheets |
| `PASSO_RENDER_TIMEOUT_MS` | int > 0, max 120000 | `10000` | `xsltproc` subprocess timeout |
| `PASSO_MAX_RENDER_BYTES` | int > 0 | `8388608` (8 MB) | Maximum render output |

Both limits bound untrusted input. `xsltproc` runs as a subprocess (the `libxslt` npm package no longer builds against modern Node), so a hostile or pathological document could otherwise consume the process indefinitely.

`PASSO_MAX_RENDER_BYTES` is applied twice: as an output cap on the subprocess, and as an input cap on `POST /render` — an 8 MB document can expand dramatically through a stylesheet.

::: warning `PASSO_XSD_DIR` missing its contents blocks everything
XSD validation is a mandatory, non-skippable gate. If the directory is absent, every submission for every tenant fails with `500 ERR_XSD_UNAVAILABLE`.

Note that `xsd.ts` and `xslt.ts` read these from `process.env` directly at module load, with the same defaults as the schema — so the validated `Config` values and the module-level constants agree, but the modules do not receive the parsed config object.
:::

## PEC polling

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `PEC_POLL_INTERVAL_MS` | int, min 5000 | `60000` | IMAP poll interval |

PEC is the only channel with no webhook — SdI replies by email, so receipts must be fetched. The 5-second floor prevents a misconfiguration from hammering a PEC provider, most of which cap concurrent IMAP connections.

A per-tenant in-flight set prevents two polls overlapping on the same mailbox.

---

# Compose and provisioning only

**The application does not read these.** They configure containers or the migration job.

## Alerts

All optional. See [Alerts](/operations/alerts).

| Variable | Default | Notes |
|---|---|---|
| `ALERT_SMTP_HOST` | *(empty)* | A normal SMTP server (not PEC). Unset: no alert email is sent |
| `ALERT_SMTP_PORT` | `587` | `465` = implicit TLS; any other port requires STARTTLS |
| `ALERT_SMTP_USER` / `ALERT_SMTP_PASSWORD` | *(empty)* | Omit both for an unauthenticated relay |
| `ALERT_FROM` | `ALERT_SMTP_USER` | Sender address |
| `OPERATOR_ALERT_EMAIL` | *(empty)* | Comma-separated; receives every alert |
| `OPERATOR_ALERT_WEBHOOK_URL` | *(empty)* | Receives every alert |
| `OPERATOR_ALERT_WEBHOOK_SECRET` | *(empty)* | Signs operator alert webhooks |
| `ALERT_REPEAT_MINUTES` | `360` | Reminder interval while a problem persists |
| `ALERT_DISPATCH_INTERVAL_MS` | `15000` | How often pending alert deliveries are sent |

## Published ports

| Variable | Default | Publishes |
|---|---|---|
| `PASSO_PORT` | `3000` | API HTTP |
| `POSTGRES_PORT` | `5432` | Postgres |
| `RABBITMQ_PORT` | `5672` | AMQP |
| `RABBITMQ_MGMT_PORT` | `15672` | RabbitMQ management UI |
| `REDIS_PORT` | `6379` | Redis |

Host side only. Container-internal ports and the service-name URLs in `.env` stay fixed — `DATABASE_URL` still says `@postgres:5432` because that is container-to-container.

::: warning These publish on all interfaces
`"5432:5432"` binds `0.0.0.0`. For anything beyond a development machine, bind to loopback or drop the mappings entirely:

```yaml
ports: ["127.0.0.1:${POSTGRES_PORT:-5432}:5432"]
```
:::

## Container credentials

| Variable | Used by |
|---|---|
| `POSTGRES_DB` | The `postgres` container's initdb |
| `POSTGRES_USER` | Same |
| `POSTGRES_PASSWORD` | Same |
| `RABBITMQ_USER` | The `rabbitmq` container |
| `RABBITMQ_PASSWORD` | Same |
| `DATABASE_ADMIN_URL` | The `migrate` service only |
| `PASSO_DB_PASSWORD` | The provisioning script, to set `passo_app`'s password |

All use the `${VAR:?message}` form in Compose, so an unset value **refuses to start** rather than silently defaulting to empty. An empty Postgres password produces a working stack with no authentication.

`DATABASE_ADMIN_URL` overrides `DATABASE_URL` for the `migrate` service alone. Creating tables, roles and policies needs privileges the runtime role must not have.

## Runtime toggles

| Variable | Read by | Purpose |
|---|---|---|
| `PASSO_ROLE` | `src/index.ts` | Role when not given as `argv[2]`: `api`, `worker`, `relay`, `mcp` |
| `PASSO_MCP_TENANT_ID` | `src/index.ts` | **Required for the `mcp` role.** Scopes the session to one tenant |
| `PASSO_ALLOW_NO_DELAYED_EXCHANGE` | `src/infra/queue/broker.ts` | `1` downgrades the missing-plugin boot refusal to a warning |

```bash
docker compose run --rm -e PASSO_MCP_TENANT_ID=<uuid> mcp
```

Without `PASSO_MCP_TENANT_ID` the MCP role logs a fatal and exits — an MCP session is scoped to exactly one tenant. See [MCP server](/integrations/mcp).

::: danger `PASSO_ALLOW_NO_DELAYED_EXCHANGE` is for local development only
Without the `rabbitmq_delayed_message_exchange` plugin, PASSO **refuses to boot**:

```
PASSO_BOOT_REFUSED: rabbitmq_delayed_message_exchange plugin is NOT installed.
Without it, every retry becomes IMMEDIATE redelivery — a hot loop that would
hammer SdI with duplicate submissions.
```

Setting this to `1` downgrades the refusal to a warning and connects on a reduced topology with no retry exchange and no `x-delay` header. The system runs and does not back off.

Never set it where real invoices are transmitted. See [Deployment](/operations/deployment).
:::

---

# Variables that do nothing

::: warning `RATE_LIMIT_POINTS` and `RATE_LIMIT_DURATION_SEC` are inert
They appear in `.env.example` but nothing reads them. They are not in the Zod schema, and `createRateLimiter(d.redis)` is called with no further arguments, taking the defaults from its own signature:

```ts
export function createRateLimiter(redis: Redis | null, points = 100, duration = 60)
```

The rate limit is **100 requests per 60 seconds**, compiled in. Setting these variables has no effect in this build.
:::

---

# A complete `.env`

```bash
NODE_ENV=production
LOG_LEVEL=info

# ── Published ports (host side only) ──
PASSO_PORT=3000
POSTGRES_PORT=5432
RABBITMQ_PORT=5672
RABBITMQ_MGMT_PORT=15672
REDIS_PORT=6379

PASSO_BASE_URL=https://passo.internal.example.com

# ── Postgres ──
POSTGRES_DB=passo
POSTGRES_USER=passo_admin
POSTGRES_PASSWORD=<generated>

# Admin connection: migrate service ONLY
DATABASE_ADMIN_URL=postgres://passo_admin:<generated>@postgres:5432/passo

# Runtime connection: least-privilege, NOBYPASSRLS
PASSO_DB_PASSWORD=<generated>
DATABASE_URL=postgres://passo_app:<generated>@postgres:5432/passo
DATABASE_POOL_MAX=10
DATABASE_STATEMENT_TIMEOUT_MS=15000

# ── RabbitMQ ──
RABBITMQ_USER=passo
RABBITMQ_PASSWORD=<generated>
RABBITMQ_URL=amqp://passo:<generated>@rabbitmq:5672

# ── Redis ──
REDIS_URL=redis://redis:6379

# ── Admin credential ──
#   openssl rand -base64 32
PASSO_ADMIN_KEY=<generated, >=24 chars>

# ── Encryption — back these up SEPARATELY ──
#   openssl rand -base64 32
PASSO_ENCRYPTION_KEY_V1=<base64, exactly 32 bytes>
PASSO_ENCRYPTION_KEY_ACTIVE=v1

# ── Retention ──
CORRELATION_RETENTION_DAYS=90
AUDIT_RETENTION_MONTHS=12
RECEIPT_ACK_GRACE_DAYS=7

# ── API behaviour ──
SYNC_MAX_WAIT_MS=120000

# ── HTTP hardening ──
PASSO_CORS_ORIGINS=
PASSO_CORS_CREDENTIALS=false
PASSO_HSTS_MAX_AGE=31536000

# ── Rendering ──
PASSO_RENDER_TIMEOUT_MS=10000
PASSO_MAX_RENDER_BYTES=8388608

# ── PEC polling ──
PEC_POLL_INTERVAL_MS=60000
```

## Generating secrets

```bash
openssl rand -base64 32   # PASSO_ADMIN_KEY
openssl rand -base64 32   # PASSO_ENCRYPTION_KEY_V1  (must be exactly 32 bytes)
openssl rand -base64 24   # database and broker passwords
```

::: tip Verify a key decodes to 32 bytes
```bash
echo -n "$PASSO_ENCRYPTION_KEY_V1" | base64 -d | wc -c   # must print 32
```

`EnvKeyProvider` checks this and refuses to start otherwise — but checking before deploying is faster than reading a crash loop.
:::
