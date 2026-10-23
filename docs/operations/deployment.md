# Deployment

One Docker Compose stack. Postgres, RabbitMQ, Redis, a one-shot migration job, and three application processes from a single image.

```bash
cp .env.example .env      # replace every CHANGE_ME
docker compose up -d --build
curl localhost:3000/health/live
```

## The stack

The project name is pinned:

```yaml
name: passo
```

Containers and volumes are therefore predictable — `passo-api`, `passo_postgres_data` — regardless of the directory name. That matters because volume names are how your data is found again after a `docker compose down`.

Eight services are defined:

| Service | Image | Role | Runs |
|---|---|---|---|
| `postgres` | `postgres:16` | Durability boundary | always |
| `rabbitmq` | **custom build** | Transport and delayed retry | always |
| `redis` | `redis:7` | Rate-limit counters | always |
| `migrate` | `passo:local` | Schema + role provisioning | **one-shot** |
| `api` | `passo:local` | HTTP ingress | always |
| `worker` | `passo:local` | Queue consumers, purge, PEC poller | always |
| `relay` | `passo:local` | Outbox → RabbitMQ | always |
| `mcp` | `passo:local` | MCP stdio server | **profile `mcp`** |

Four of them share the one `passo:local` image and differ only by their `command`. `mcp` never starts with `docker compose up` — it sits behind a profile and is launched per session. See [MCP server](/integrations/mcp).

## Secrets fail loudly

```yaml
POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
```

The `:?` form makes Compose **refuse to start** when the variable is unset, instead of substituting an empty string. An empty Postgres password produces a working stack with no authentication — a failure that looks exactly like success.

The application does the same at its own layer: `loadConfig()` validates the whole environment with Zod before any connection is opened, and reports every problem at once rather than one per restart. `PASSO_ADMIN_KEY` and an encryption key are both mandatory, and neither is ever defaulted or generated — a generated secret ends up in shell history and log files.

## Every external port is configurable

| Variable | Default | Maps to |
|---|---|---|
| `PASSO_PORT` | 3000 | API HTTP |
| `POSTGRES_PORT` | 5432 | Postgres |
| `RABBITMQ_PORT` | 5672 | AMQP |
| `RABBITMQ_MGMT_PORT` | 15672 | RabbitMQ management UI |
| `REDIS_PORT` | 6379 | Redis |

```yaml
ports: ["${POSTGRES_PORT:-5432}:5432"]
```

Only the host side moves; container-internal ports and the service-name URLs in `.env` stay fixed. So this coexists with another Postgres on 5432:

```bash
PASSO_PORT=3100
POSTGRES_PORT=15432
RABBITMQ_PORT=15672
RABBITMQ_MGMT_PORT=15673
REDIS_PORT=16379
```

`DATABASE_URL` still says `@postgres:5432` — that is container-to-container over the Compose network and must not change.

::: danger `PASSO_PORT` is not `PORT`
Compose maps `"${PASSO_PORT:-3000}:3000"`. The application reads **`PORT`** from `config.ts`, and it defaults to 3000.

`PASSO_PORT` changes only the **host-side** published port. It never reaches the process. Setting `PASSO_PORT=3100` gives you `localhost:3100` on the host while the container still listens on 3000 — which is exactly what the mapping needs.

Do **not** set `PORT` in `.env` unless you also change the container side of the port mapping and the healthcheck URL, which are both hardcoded to 3000. In practice: use `PASSO_PORT`, leave `PORT` alone.
:::

::: warning Ports are published on all interfaces
`"5432:5432"` binds `0.0.0.0`. Postgres, RabbitMQ and Redis have no business being reachable from outside the host.

For anything beyond a development machine, bind to loopback or drop the mappings entirely — the services reach each other over the Compose network without any published port:

```yaml
ports: ["127.0.0.1:${POSTGRES_PORT:-5432}:5432"]
```
:::

## The custom RabbitMQ image

```yaml
rabbitmq:
  build: ./docker/rabbitmq
  image: passo-rabbitmq:local
```

**The official `rabbitmq` image does not bundle `rabbitmq_delayed_message_exchange`.** PASSO's retry ladder depends on it entirely.

### What goes wrong without it

The broker declares a delayed exchange at boot:

```ts
await ch.assertExchange(EXCHANGES.retry, 'x-delayed-message', {
  durable: true, arguments: { 'x-delayed-type': 'topic' },
});
```

Without the plugin, `x-delayed-message` is not a recognised exchange type. The assert fails and the channel closes.

If that failure were swallowed, every retry publish would carry an `x-delay` header that nothing honours, and the broker would deliver the message **immediately**. The exponential ladder — 5 s, 10 s, 20 s, 40 s, 80 s for submissions — collapses into five immediate redeliveries.

::: danger PASSO refuses to boot without the plugin
A hot loop against SdI presents as "our retries are far too aggressive" or "we are hammering the vendor". Nobody's first instinct is "a broker plugin is missing", because the retry configuration in the code is visibly correct.

So PASSO does not start at all. `connectBroker` catches the failed assert, closes the connection and throws:

```
PASSO_BOOT_REFUSED: rabbitmq_delayed_message_exchange plugin is NOT installed.
Without it, every retry becomes IMMEDIATE redelivery — a hot loop that would hammer
SdI with duplicate submissions. Build the broker from docker/rabbitmq/Dockerfile,
which bakes the plugin in. To run degraded anyway (local development only), set
PASSO_ALLOW_NO_DELAYED_EXCHANGE=1.
```

A crash-looping container with that message is a far better outcome than a running system that silently duplicates submissions to a tax authority.
:::

::: warning The degraded escape hatch is for local development only
`PASSO_ALLOW_NO_DELAYED_EXCHANGE=1` downgrades the refusal to a warning and connects on a reduced topology: queues bind to `passo.invoices` and the DLX but **not** to `passo.retry`, and `publish` drops the `x-delay` header.

The system runs. It does not back off. Never set this where real invoices are transmitted.
:::

Verify it:

```bash
docker compose exec rabbitmq rabbitmq-plugins list -e | grep delayed
# rabbitmq_delayed_message_exchange   3.13.0
```

### Building the image

```dockerfile
FROM rabbitmq:3.13-management
ARG PLUGIN_VERSION=3.13.0
USER root
RUN curl -fsSL -o "$RABBITMQ_HOME/plugins/rabbitmq_delayed_message_exchange.ez" "${PLUGIN_URL}"; \
    chown rabbitmq:rabbitmq "$RABBITMQ_HOME/plugins/rabbitmq_delayed_message_exchange.ez"; \
    rabbitmq-plugins enable --offline rabbitmq_delayed_message_exchange
USER rabbitmq
```

::: warning Restore the `rabbitmq` user
The plugin download needs root. Leaving the image as root breaks the permissions on `/var/lib/rabbitmq/.erlang.cookie` and the broker dies at boot with an `eacces` error that says nothing about file ownership.

`USER rabbitmq` on the last line is not tidiness — it is the fix for a startup crash.
:::

The plugin version must track the broker's minor version. Pin both.

## The `migrate` one-shot

```yaml
migrate:
  build: .
  command: ["node", "--experimental-strip-types", "scripts/migrate-and-provision.mjs"]
  environment:
    DATABASE_URL: ${DATABASE_ADMIN_URL:?set DATABASE_ADMIN_URL in .env}
  depends_on:
    postgres: {condition: service_healthy}
  restart: "no"
```

Three details:

**It runs as the admin role.** `DATABASE_ADMIN_URL` overrides `DATABASE_URL` for this service only. Creating tables, roles and policies needs privileges the runtime role must not have — `passo_app` is `NOSUPERUSER NOBYPASSRLS` precisely so RLS applies to it.

**`restart: "no"`.** It is a job. Restarting a completed migration is at best wasted work.

**Everything else waits for it:**

```yaml
depends_on:
  migrate: {condition: service_completed_successfully}
```

`api`, `worker` and `relay` will not start until the migration exits zero. A failed migration blocks the whole stack rather than producing three processes crash-looping against a half-built schema.

The schema is applied by `node-pg-migrate`, which is installed explicitly in the image rather than fetched at runtime by `npx` — `npx` needs a writable `HOME` and network access the container should not have.

## Healthchecks

**Only `api` has one**, and it targets liveness:

```yaml
healthcheck:
  test: ["CMD", "node", "-e",
         "fetch('http://localhost:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  interval: 15s
  timeout: 5s
  retries: 3
  start_period: 20s
```

`postgres`, `rabbitmq` and `redis` have their own (`pg_isready`, `rabbitmq-diagnostics ping`, `redis-cli ping`) — those are what `depends_on: service_healthy` waits on. `worker` and `relay` have none: they expose no port, and their health is expressed as queue depth and outbox lag rather than as a probe.

### Liveness vs readiness

| Endpoint | Checks | Use for |
|---|---|---|
| `/health/live` | The process is up. Nothing external — not even the database | Restart policy |
| `/health/ready` | Postgres and Redis | Load-balancer rotation |

The Compose healthcheck deliberately uses **liveness**. A readiness check as a restart trigger creates a cascade: Postgres blips, readiness fails, Docker kills the API, the API restarts into a database that is still recovering, repeat.

::: tip Readiness deliberately excludes SdI vendors
`/health/ready` checks Postgres and Redis and stops there. It does not probe Invoicetronic, OpenAPI.it or a PEC provider.

This is a decision, not an omission. Postgres is the durability boundary: an invoice accepted during a vendor outage is committed, queued, and transmits when the vendor returns. Nothing is lost by continuing to accept.

If readiness included vendors, a vendor's bad afternoon would pull PASSO out of rotation and start returning `503` to a CRM that could otherwise have handed over its invoices safely. The outage would be amplified rather than absorbed.
:::

Neither endpoint is authenticated, and neither reveals anything beyond up/down and which internal dependency is unhappy.

## Graceful shutdown

```yaml
api:    stop_grace_period: 45s
worker: stop_grace_period: 45s
relay:  stop_grace_period: 30s
```

Each role registers `SIGTERM` and `SIGINT` handlers that run its teardown stack in order — stop the listener or the poll loop, close the broker connection, drain the pool, exit.

`dumb-init` is the entrypoint, so signals actually reach the Node process instead of being swallowed by PID 1.

45 seconds covers an in-flight vendor submission (a 30-second `AbortSignal.timeout`) plus teardown. Relay work is short, so 30 is ample.

::: tip A hard kill is survivable
This is graceful, not required. An unacked RabbitMQ message is redelivered; an unpublished outbox row is picked up on the next tick; a partially-processed submission is re-read and skipped if its state moved on. The grace period reduces churn — it does not protect correctness. Correctness lives in the transactional outbox.
:::

## The application image

### debian-slim, not Alpine

```dockerfile
FROM node:22-bookworm-slim AS deps
```

Two hard dependencies drive this:

- **`libxmljs2`** — a native addon, used for mandatory XSD validation
- **`xsltproc`** — the OS binary that applies the official AdE stylesheets

Both are fragile on musl. Alpine's musl vs glibc difference produces subtle native-addon breakage, and a validation failure here means a rejected tax document. The image is perhaps 40 MB larger; that is not a trade worth making.

`xsltproc` runs as a subprocess because the `libxslt` npm package no longer builds against modern Node — it targets V8 APIs that have been removed.

### Three stages

| Stage | Purpose |
|---|---|
| `deps` | Compiles native addons with `python3`, `build-essential`, `libxml2-dev` |
| `check` | Installs dev dependencies and runs `tsc --noEmit` |
| `runtime` | `xsltproc`, `libxml2`, `dumb-init`; copies `node_modules` from `deps` |

The runtime stage gets `libxml2` (the shared library) but not `libxml2-dev` (headers) — compilation already happened.

::: danger Never copy `node_modules` from the host
```
Error: /app/node_modules/libxmljs2/build/Release/xmljs.node:
  invalid ELF header
```

Native addons are compiled against a specific libc and Node ABI. A `node_modules` built on macOS, or on Alpine, or by a different base image, contains binaries that cannot load here.

Two things prevent it:

1. `.dockerignore` excludes `node_modules`, so `COPY` cannot pick up the host's.
2. The runtime stage copies from `deps` — the stage that compiled them, in this image, against this libc.

If you ever see "invalid ELF header", something bypassed one of those. Rebuild with `--no-cache`.
:::

### Vendored XSD

```dockerfile
COPY assets ./assets
```

`assets/xsd` carries a **vendored** `xmldsig-core-schema.xsd`. Upstream, the FatturaPA XSD imports it from a `w3.org` URL — which means schema compilation, and therefore every submission, would need outbound network access to w3.org.

The import was rewritten to a relative path. `libxml` resolves it against the document's `baseUrl`, which is why the loader sets `baseUrl` to the schema directory; without that, compilation fails with the entirely unhelpful "Invalid XSD schema".

If `assets/` is missing from the image, every submission fails with `500 ERR_XSD_UNAVAILABLE`, for every tenant. The XSD gate is mandatory and non-skippable.

### Non-root with a real HOME

```dockerfile
RUN groupadd -r -g 10001 passo \
    && useradd -r -u 10001 -g passo -m -d /home/passo passo \
    && chown -R passo:passo /app /home/passo
USER passo
ENV HOME=/home/passo
```

::: warning `-m -d /home/passo` is required
Node and npm write caches to `HOME`. With no home directory they fail with `EACCES` on a path that does not exist — an error that points at a cache write, not at a missing user directory.

`-m` creates it; `chown` makes it writable; `ENV HOME` makes it findable.
:::

## First run

```bash
cp .env.example .env
```

Replace every `CHANGE_ME`:

```bash
openssl rand -base64 32   # PASSO_ADMIN_KEY
openssl rand -base64 32   # PASSO_ENCRYPTION_KEY_V1
```

`PASSO_ENCRYPTION_KEY_V1` must be **exactly 32 bytes base64-decoded**. `EnvKeyProvider` checks the decoded length and refuses to start otherwise.

```bash
docker compose up -d --build
docker compose logs -f migrate
curl localhost:3000/health/live
curl localhost:3000/health/ready
docker compose exec rabbitmq rabbitmq-plugins list -e | grep delayed
```

Then provision a tenant — see [the Admin API](/api/admin#bootstrapping-a-tenant-end-to-end).

## Scaling

```bash
docker compose up -d --scale worker=4
```

`worker` scales horizontally without coordination: RabbitMQ distributes messages, `prefetch` is 4 per consumer, and every job re-reads submission state before acting.

`api` scales too, but the port mapping is fixed to one host port — put a reverse proxy in front and drop the mapping.

`relay` can run several replicas safely because of `FOR UPDATE SKIP LOCKED`, though one is usually enough: it polls every 200 ms and batches 100 rows.

::: warning Run Redis if you scale the API
Without Redis the rate limiter falls back to an in-process counter, so `N` replicas allow `N × 100` requests per minute. The limit stops meaning anything.
:::

`postgres` does not scale by replication here. It is the durability boundary; scale it vertically or with managed replication outside this stack.

## Operating commands

```bash
docker compose ps
docker compose logs -f api worker relay
docker compose logs api | grep -i error

docker compose restart worker         # safe: unacked messages redeliver
docker compose up -d --build          # rebuild and roll
docker compose exec postgres psql -U passo_admin -d passo

docker compose down                   # stop, keep volumes
docker compose down -v                # DESTROY all data
```

::: danger `down -v` deletes the database
It removes `passo_postgres_data`, `passo_rabbitmq_data` and `passo_redis_data`. There is no confirmation prompt. `npm run stack:reset` does exactly this.

If any submission is in flight, its payload, its XML and its correlation record are gone — and a receipt arriving afterwards will have nothing to route to.
:::

## Production notes

The Compose file is a working single-host deployment, not a hardened one. Before real invoices:

1. **Do not publish database ports.** Bind to loopback or drop the mappings.
2. **Terminate TLS in front of the API.** Nothing in the stack does it.
3. **Back up Postgres — and the encryption keys.** A database backup without key material restores unreadable ciphertext. See [Backup & restore](/operations/backup).
4. **Consider a real key provider.** The env provider is the self-hosted default; anyone who can read the process environment can read the key. See [Security](/operations/security).
5. **Ship logs somewhere.** `docker compose logs` is bounded by the container's log driver.
6. **Watch queue depth and outbox lag.** Neither has a healthcheck; both are your early warning.
7. **Test the restore.** An untested backup has never been shown to work.
