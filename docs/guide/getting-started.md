# Getting Started

## Run it

```bash
cp .env.example .env
# Replace every CHANGE_ME. Generate secrets with:
#   openssl rand -base64 32
docker compose up -d
curl http://localhost:3000/health/live
```

PASSO **refuses to start** if `PASSO_ADMIN_KEY` or an encryption key is missing. It never generates a default — a generated secret ends up in shell history and logs.

## Create a tenant and a key

A **tenant** is one CRM integration. Each gets its own API key, webhooks, transformations and channel configuration, isolated at the database level.

```bash
ADMIN="your-PASSO_ADMIN_KEY"

curl -X POST localhost:3000/api/v1/admin/tenants \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"Acme CRM","slug":"acme","transmitterCode":"01234567890"}'

curl -X POST localhost:3000/api/v1/admin/tenants/<tenantId>/api-keys \
  -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"name":"production"}'
```

The key is shown **once**. It is stored as a bcrypt hash and cannot be retrieved again.

## Submit an invoice

```bash
curl -X POST localhost:3000/api/v1/invoices \
  -H "authorization: Bearer passo_live_..." \
  -H 'content-type: application/json' \
  -H 'idempotency-key: your-unique-key' \
  -d '{ "sellerId": "...", "invoice": { ... } }'
```

You get **202 Accepted** with a `submissionId`. Transmission happens asynchronously; the result arrives by webhook, or by polling `GET /invoices/{id}`.

## Three rules that catch most integrations

**1. NS is terminal.** An `invoice.rejected` webhook means SdI refused the file — the invoice is **legally not issued**. Calling `/retry` returns `409` and refuses. Fix the invoice and submit it as a **new** one; PASSO allocates a fresh `ProgressivoInvio`. Retrying would send a duplicate to the tax authority.

**2. MC is not a failure.** `invoice.exception` with `notificationType: "MC"` means SdI could not yet deliver to the recipient — but the invoice **is** legally issued (`legallyIssued: true`). SdI keeps trying. Do not resubmit.

**3. Money is a string with a mandatory decimal.** `"1000.00"`, never `1000` and never the JSON number `1000.00`. FatturaPA amounts are patterned strings; a bare integer is schema-invalid and rejected.
