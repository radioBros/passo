# PASSO

<p align="center">
  <img src="docs/public/logo.png" alt="PASSO" width="96">
</p>

**Italian e-invoicing relay.** Takes invoice data from any CRM, produces valid FatturaPA XML, transmits it to the Sistema di Interscambio through a pluggable channel, and returns the receipts.

Self-hosted. Open source. API-only. Version **1.0.0**.

[![CI](https://github.com/radioBros/passo/actions/workflows/ci.yml/badge.svg)](https://github.com/radioBros/passo/actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)

```
CRM ──POST /invoices──▶ PASSO ──▶ PEC │ OpenAPI.it ──────────────────▶ SdI
                          │                                             │
CRM ◀──── webhook ────────┴────────── receipts (RC/NS/MC/NE/DT/AT) ◀────┘
```

```bash
cp .env.example .env      # replace every CHANGE_ME
docker compose up -d --wait
curl localhost:${PASSO_PORT:-3000}/health/live
```

The stack is one Compose project named `passo` — API, worker, outbox relay, Postgres, RabbitMQ and Redis. Every published port comes from `.env` (`PASSO_PORT`, `POSTGRES_PORT`, `RABBITMQ_PORT`, `RABBITMQ_MGMT_PORT`, `REDIS_PORT`), so it drops onto a host that already has services running.

---

## Contents

- [What it is](#what-it-is)
- [What it is not](#what-it-is-not)
- [Three rules that catch most integrations](#three-rules-that-catch-most-integrations)
- [Channels](#channels)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API](#api)
- [Webhooks](#webhooks)
- [Operator CLI](#operator-cli)
- [MCP server](#mcp-server)
- [Development](#development)
- [Testing and CI](#testing-and-ci)
- [Security](#security)
- [Retention and privacy](#retention-and-privacy)
- [Documentation](#documentation)
- [Repository layout](#repository-layout)
- [Status of 1.0.0](#status-of-100)
- [Contributing](#contributing)
- [Licence](#licence)

---

## What it is

PASSO is middleware. Your CRM remains the system of record. PASSO:

- **Validates** the payload against a canonical invoice model, then against the official Agenzia delle Entrate XSD. An invoice that fails the XSD never leaves the API.
- **Generates** FatturaPA XML (FPR12 B2B, FPA12 B2G) and allocates a unique `ProgressivoInvio` per transmitter.
- **Transmits** through a configured channel — your PEC mailbox, or OpenAPI.it (the supported path for B2G, because it can sign).
- **Applies receipts** (RC / NS / MC / NE / DT / AT) to a state machine that refuses the two expensive mistakes: auto-retrying an NS, and treating an MC as a failure.
- **Pushes outcomes** to your CRM as HMAC-signed webhooks. If the endpoint is down, `GET /pending` is the reconciliation queue — nothing is silently dropped.
- **Isolates tenants** with Postgres row-level security. One instance can serve many CRMs.
- **Survives crashes** via a transactional outbox: `202 Accepted` means the invoice is in Postgres. The relay publishes to RabbitMQ afterwards.
- **Renders** invoices and receipts with the official AdE stylesheets — the same view the tax portal shows.
- **Optionally** exposes an MCP server so an LLM can inspect one tenant and diagnose failures, without the ability to widen that scope.

There is no web UI. The operator surface is the Admin API and `passo-cli`.

## What it is not

Not an accredited SdI intermediary. Not a *conservazione a norma* provider. Not the system of record — **your CRM is**. Not certified. Not tax advice.

PASSO holds no invoice archive. Payloads are purged once a terminal receipt arrives, leaving a correlation record of identifiers and status. Fetch XML, receipts and the rendered view **before** purge — afterwards those endpoints return `410 Gone`. See [What PASSO is not](docs/guide/scope.md).

---

## Three rules that catch most integrations

1. **NS is terminal.** SdI refused the file. The invoice is legally *not issued*. `/retry` answers `409`. Fix it and submit a **new** invoice.
2. **MC is not a failure.** SdI accepted the invoice and could not yet deliver it. The invoice **is** issued (`legallyIssued: true`). SdI keeps trying. Do not resubmit.
3. **Money is a string.** `"1000.00"`, never `1000` and never the JSON number `1000.00`. FatturaPA amounts are patterned strings; a bare integer is schema-invalid.

---

## Channels

Configured per tenant. Switching channel is configuration, not a code change.

| Channel | Signing | Receipts | Status |
|---|---|---|---|
| **PEC** | none — B2B only | IMAP polling | Supported |
| **OpenAPI.it** | vendor-side when `requestSigning` is on | webhook + polling | Supported. Use it for B2G |
| **Invoicetronic** | vendor-side | webhook | Adapter included, **not** proven end to end |
| **Mock** | simulated | simulated | Development and CI only |

PEC cannot sign, and PASSO does not accept a pre-signed `.p7m`. A B2G invoice over PEC is refused at validation. See [Channels](docs/integrations/channels.md).

---

## Requirements

- Docker and Docker Compose, **or** Node.js 22+, Postgres 16, Redis 7, and RabbitMQ with `rabbitmq_delayed_message_exchange`
- `xsltproc` and `libxml2` on the host if you run outside Compose (the image already has them)
- A channel: an accredited PEC mailbox, or an OpenAPI.it token

PASSO **refuses to boot** without `PASSO_ADMIN_KEY` and an encryption key, and without the delayed-message plugin (retries would become immediate redelivery against SdI). It never generates a default secret.

---

## Quick start

### 1. Configure and start

```bash
git clone https://github.com/radioBros/passo.git
cd passo
cp .env.example .env
# openssl rand -base64 32   → PASSO_ADMIN_KEY and PASSO_ENCRYPTION_KEY_V1
# openssl rand -hex 16      → database and RabbitMQ passwords
docker compose up -d --wait
curl localhost:3000/health/live
curl localhost:3000/health/ready
```

`/health/live` checks the process only. `/health/ready` checks Postgres and Redis and **excludes** SdI vendors on purpose: a vendor outage must not take PASSO out of rotation.

### 2. Provision a tenant, a seller, a channel, a key

```bash
ADMIN="$(grep '^PASSO_ADMIN_KEY=' .env | cut -d= -f2-)"
BASE=localhost:3000/api/v1

TID=$(curl -sS -X POST $BASE/admin/tenants \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"Acme CRM","slug":"acme","transmitterCode":"01234567890"}' | jq -r .id)

SID=$(curl -sS -X POST $BASE/admin/tenants/$TID/sellers \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"taxRegime":"RF01","denomination":"Fornitore S.r.l.",
       "vatCountry":"IT","vatCode":"01234567890",
       "address":{"street":"Via Roma 1","postalCode":"20100","city":"Milano","province":"MI","country":"IT"}}' \
  | jq -r .id)

# Development: the mock channel transmits nowhere.
curl -sS -X PUT $BASE/admin/tenants/$TID/channels/mock \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{}'

KEY=$(curl -sS -X POST $BASE/admin/tenants/$TID/api-keys \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"dev"}' | jq -r .key)
# The key is shown once. Store it.
```

For production, configure `pec` or `openapi` instead of `mock`. See [Channels](docs/integrations/channels.md).

### 3. Submit an invoice

```bash
curl -sS -X POST $BASE/invoices \
  -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -H "idempotency-key: $(uuidgen)" \
  -d "{
    \"sellerId\": \"$SID\",
    \"crmInvoiceRef\": \"SO-2026-0042\",
    \"invoice\": {
      \"documentType\": \"TD01\",
      \"number\": \"2026/0042\",
      \"date\": \"2026-09-01\",
      \"currency\": \"EUR\",
      \"format\": \"FPR12\",
      \"recipientCode\": \"ABC1234\",
      \"seller\": {
        \"vatId\": { \"country\": \"IT\", \"code\": \"01234567890\" },
        \"name\": \"Fornitore S.r.l.\",
        \"taxRegime\": \"RF01\",
        \"address\": { \"street\": \"Via Roma\", \"postalCode\": \"20100\",
                       \"city\": \"Milano\", \"province\": \"MI\", \"country\": \"IT\" }
      },
      \"buyer\": {
        \"vatId\": { \"country\": \"IT\", \"code\": \"09876543210\" },
        \"name\": \"Cliente S.p.A.\",
        \"address\": { \"street\": \"Via Milano\", \"postalCode\": \"00100\",
                       \"city\": \"Roma\", \"province\": \"RM\", \"country\": \"IT\" }
      },
      \"lines\": [{
        \"lineNumber\": 1, \"description\": \"Consulenza\",
        \"quantity\": \"10.00\", \"unitPrice\": \"100.00\",
        \"totalPrice\": \"1000.00\", \"vatRate\": \"22.00\"
      }],
      \"summaries\": [{
        \"vatRate\": \"22.00\", \"taxableAmount\": \"1000.00\",
        \"taxAmount\": \"220.00\", \"vatCollectability\": \"I\"
      }]
    }
  }"
```

You get **202 Accepted** with `submissionId` and `trackingUrl`. Transmission is asynchronous. Outcomes arrive by webhook, or by polling `GET /invoices/{id}`.

The full field catalogue is in [Invoice data model](docs/api/invoice-model.md). Every tenant endpoint is in [API overview](docs/api/overview.md).

---

## Configuration

Copy [`.env.example`](.env.example) and replace every `CHANGE_ME`. Boot validation runs **before any connection opens**; a missing or malformed value fails at startup with the variable *name*, never the value.

Critical distinctions:

| Variable | Who reads it | If you get it wrong |
|---|---|---|
| `PASSO_PORT` | Compose — host publish | The port on the machine |
| `PORT` | The Node process (container-internal, default 3000) | Do not set this in `.env` to move the host port |
| `DATABASE_URL` | The app — **must** be `passo_app` (RLS applies) | Pointing this at `passo_admin` disables tenant isolation |
| `DATABASE_ADMIN_URL` | The migrate job only | Schema and role provisioning |
| `PASSO_BASE_URL` | `trackingUrl` in API responses | Wrong value → working invoices, unreachable links |

Full list: [Configuration](docs/reference/configuration.md).

---

## API

Two route groups on one server:

| Prefix | Auth | For |
|---|---|---|
| `/api/v1` | Tenant API key (`passo_live_…` / `passo_test_…`) | Submit and track invoices |
| `/api/v1/admin` | `PASSO_ADMIN_KEY` | Tenants, keys, sellers, channels, operations |

Bearer token in `authorization`. Keys are bcrypt-hashed and shown **once**. Every JSON body carries `requestId` (echoed from `x-request-id` if you send one).

**Tenant — invoices**

| Method | Path | Scope |
|---|---|---|
| `POST` | `/invoices` | `invoices:write` |
| `GET` | `/invoices` | `invoices:read` |
| `GET` | `/invoices/{id}` | `invoices:read` |
| `POST` | `/invoices/{id}/retry` | `invoices:write` |
| `GET` | `/invoices/{id}/xml` | `invoices:read` |
| `GET` | `/invoices/{id}/rendered` | `invoices:read` |
| `GET` | `/invoices/{id}/receipts` | `invoices:read` |
| `GET` | `/invoices/{id}/export` | `invoices:read` |
| `POST` | `/invoices/{id}/ack` | `invoices:write` |
| `GET` | `/pending` | `invoices:read` |
| `POST` | `/render` | `invoices:read` |

**Tenant — webhooks, transformations, catalogues, privacy**

| Method | Path | Scope |
|---|---|---|
| `POST` `GET` `PATCH` `DELETE` | `/webhooks`, `/webhooks/{id}` | `webhooks:*` |
| `POST` | `/webhooks/{id}/rotate-secret` | `webhooks:write` |
| `GET` | `/webhooks/{id}/deliveries` | `webhooks:read` |
| `POST` | `/transformations/test` | `invoices:write` |
| `GET` | `/starter-templates` | `invoices:read` |
| `POST` | `/transformations/from-starter/{key}` | `transformations:write` |
| `GET` | `/scopes`, `/webhook-events`, `/sdi-errors` | `invoices:read` |
| `POST` | `/privacy/erasure` | `invoices:read` |
| `POST` | `/inbound/{token}` | vendor path token |

Machine-readable contract: [`docs/public/openapi.json`](docs/public/openapi.json), generated from the Zod schemas. CI fails if the schemas change without regenerating it.

Full narrative docs: [API overview](docs/api/overview.md) · [Invoices](docs/api/invoices.md) · [Invoice model](docs/api/invoice-model.md) · [Webhooks](docs/api/webhooks.md) · [Transformations](docs/api/transformations.md) · [Privacy](docs/api/privacy.md) · [Admin](docs/api/admin.md) · [Errors](docs/api/errors.md) · [OpenAPI reference](docs/api/reference.md).

```bash
npm run docs:dev       # VitePress site at http://localhost:5173
```

---

## Webhooks

At-least-once, HMAC-SHA256 over `"<unix>.<rawBody>"`, header `X-Passo-Signature: t=…,v1=…`. Dedupe on `eventId`. Compute the signature over the **raw body bytes**.

| Event | Meaning | What to do |
|---|---|---|
| `invoice.submitted` | Queued in PASSO | Wait |
| `invoice.transmitted` | Reached SdI (AT) | Wait for a receipt |
| `invoice.delivered` | RC or DT | Nothing |
| `invoice.rejected` | **NS — not issued** | New invoice, never `/retry` |
| `invoice.exception` | **MC — issued, still delivering** | Nothing |
| `invoice.transmitted_undelivered` | AT, delivery window expired | Notify the recipient yourself |
| `invoice.accepted_by_pa` / `invoice.rejected_by_pa` | NE EC01 / EC02 (B2G) | EC02 is commercial, not fiscal |
| `submission.failed` | Never reached SdI | Fix and resubmit |
| `invoice.timeout` | No receipt yet | Inspect status |
| `apikey.expiring` / `apikey.expired` | Key lifecycle | Rotate |

A 6-attempt ladder (1 s → 1 h). Exhausted events stay in `GET /pending`. Details: [Webhooks](docs/api/webhooks.md).

---

## Operator CLI

Run inside the `api` container so it has the same environment as the process:

```bash
passo() {
  docker compose exec -T api node --experimental-strip-types src/cli/passo-cli.ts "$@"
}

passo tenant create "Acme CRM" acme 01234567890
passo key create <tenant-id> production
passo dlq list                     # RabbitMQ dead letters
passo dlq replay submit
passo quarantine list              # receipts that could not be routed
passo audit verify <tenant-id>     # hash-chain check
passo purge run                    # on-demand purge
```

See [CLI](docs/reference/cli.md).

---

## MCP server

Off by default. One tenant per process — there is no tool argument that widens that.

```bash
PASSO_MCP_TENANT_ID=<tenant-uuid> docker compose --profile mcp run --rm mcp
```

Prefer a revocable `PASSO_MCP_KEY` (`passo_mcp_…`) over the tenant-id env var. Tools include `list_submissions`, `get_submission`, `list_pending`, `analyse_failures`. Retry is opt-in (`invoices:write`) and still refuses NS and MC. See [MCP](docs/integrations/mcp.md).

---

## Development

```bash
npm install
docker compose up -d postgres rabbitmq redis
docker compose run --rm migrate
# .env.test already points at the published ports from .env
npm test
npm run test:coverage
npm run lint && npm run typecheck
npm run lint:docs
npm run check:openapi
```

Hot-reload the stack:

```bash
npm run dev          # compose + docker-compose.dev.yml
npm run seed:dev     # optional fixture tenant
```

Native modules (`libxmljs2`) must be built for the Node version you run. CI uses Node 22.

---

## Testing and CI

Tests run against **real** Postgres, RabbitMQ and Redis, not mocks — RLS, `SKIP LOCKED` and the delayed-message retry ladder cannot be verified against a fake.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) on every push and pull request:

1. Typecheck, ESLint (`--max-warnings 0`), OpenAPI freshness, documentation-claim lint, VitePress build (dead links fail)
2. Migrate + provision roles, then the full suite with coverage gates (statements 80, lines 84, functions 77, branches 73)
3. `npm audit --audit-level=high` and **gitleaks** over the full history
4. Image build, native-path smoke test, Trivy (HIGH/CRITICAL, fail on fixable)
5. Full Compose stack smoke test (health + admin tenant create)

---

## Security

- AES-256-GCM at rest, bound with AAD to tenant **and** column — ciphertext cannot be transplanted between tenants or columns
- Tenant isolation is Postgres RLS on a `NOSUPERUSER NOBYPASSRLS` role, not an application `WHERE`
- Webhook URLs are SSRF-checked at registration **and** at every delivery
- Secrets are redacted in logs; boot errors name the variable, never the value
- API containers are `read_only`, `cap_drop: ALL`, `no-new-privileges`
- Hash-chained audit log; `passo-cli audit verify` for cron
- No default credentials. CORS is off. Helmet CSP is `default-src 'none'`

Report vulnerabilities privately — see [SECURITY.md](SECURITY.md). Operational detail: [Security](docs/operations/security.md).

---

## Retention and privacy

| What | Kept | After |
|---|---|---|
| Invoice JSON and generated XML | Until a terminal receipt, then purge | `410 Gone` |
| Unacknowledged receipts | Until `POST /invoices/{id}/ack` + grace (`RECEIPT_ACK_GRACE_DAYS`) | Purge |
| Correlation record | `CORRELATION_RETENTION_DAYS` (default 90) | Identifiers and status only — no fiscal payload |
| Audit log | `AUDIT_RETENTION_MONTHS` (default 12) | Hash-chained; not erasable on request |

`GET /invoices/{id}/export` is the pre-purge package (XML, hashes over plaintext, rendering, receipts). `POST /privacy/erasure` reports what is held; it does not delete an in-flight transmission. See [Privacy](docs/api/privacy.md) and [Data protection](docs/compliance/data-protection.md).

---

## Documentation

```bash
npm run docs:dev       # or: npm run docs:build
```

| Section | Pages |
|---|---|
| **Guide** | [Getting started](docs/guide/getting-started.md) · [Architecture](docs/guide/architecture.md) · [Scope](docs/guide/scope.md) · [Lifecycle](docs/guide/lifecycle.md) · [Integration modes](docs/guide/integration-modes.md) · [Tenancy](docs/guide/tenancy.md) · [FatturaPA primer](docs/guide/fatturapa.md) |
| **API** | [Overview](docs/api/overview.md) · [OpenAPI](docs/api/reference.md) · [Invoices](docs/api/invoices.md) · [Model](docs/api/invoice-model.md) · [Webhooks](docs/api/webhooks.md) · [Transformations](docs/api/transformations.md) · [Privacy](docs/api/privacy.md) · [Admin](docs/api/admin.md) · [Errors](docs/api/errors.md) |
| **Integrations** | [Channels](docs/integrations/channels.md) · [Transformations](docs/integrations/transformations.md) · [MCP](docs/integrations/mcp.md) |
| **Operations** | [Runbook](docs/operations/runbook.md) · [Deployment](docs/operations/deployment.md) · [Security](docs/operations/security.md) · [Backup](docs/operations/backup.md) · [Sizing](docs/operations/sizing.md) · [Alerts](docs/operations/alerts.md) · [DLQ](docs/operations/dlq.md) · [Troubleshooting](docs/operations/troubleshooting.md) |
| **Reference** | [Configuration](docs/reference/configuration.md) · [CLI](docs/reference/cli.md) · [Schema](docs/reference/schema.md) · [Queues](docs/reference/queues.md) |

---

## Repository layout

```
src/api/            HTTP server, auth, tenant + admin + inbound routes
src/domain/         Invoice model, generator, notifications, webhooks, alerts
src/infra/          Channels, crypto, Postgres, RabbitMQ, XSD/XSLT
src/workers/        Submit, receipts, webhooks, purge, pollers
src/cli/            passo-cli
src/mcp/            MCP server
migrations/         node-pg-migrate, including role provisioning
assets/             Official AdE XSD, XSL, control-list PDF
docs/               VitePress site
docs/public/        Generated openapi.json
tests/              Unit + integration against real services
scripts/            OpenAPI codegen, sandbox e2e, backup, seed
```

---

## Status of 1.0.0

Supported and exercised: PEC (B2B), OpenAPI.it sandbox (B2B and B2G with vendor signing), mock channel, multi-tenant RLS, outbox, webhooks, transformations, alerts, MCP, purge.

Intentionally not in this release:

- Inbound reception (MT / EC / SE are recognised and quarantined)
- Uploading a pre-signed `.p7m`
- A proven Invoicetronic path (adapter is present)
- A web UI
- A Vault/KMS key provider (the `KeyProvider` interface exists; only the env implementation ships)
- A hosted instance — you run it

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

Bug reports and features: [GitHub Issues](https://github.com/radioBros/passo/issues). Security: [SECURITY.md](SECURITY.md).

---

## Licence

[AGPL-3.0-or-later](LICENSE).

If you run a modified PASSO as a network service, you must offer the corresponding source to the users of that service. Using PASSO unmodified as middleware in front of your CRM does not, by itself, require you to publish the CRM.

Official FatturaPA XSD and stylesheets under `assets/` are published by Agenzia delle Entrate and remain theirs.

PASSO is software, not tax advice. Consult a *commercialista*.
