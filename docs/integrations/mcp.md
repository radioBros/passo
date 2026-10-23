# MCP Server

PASSO ships a Model Context Protocol server so an LLM assistant can inspect and operate one tenant's invoice flow — "which invoices are stuck?", "why are we being rejected?", "retry that one".

It speaks JSON-RPC over **stdio**, not HTTP. It is not a service you leave running; it is a process an MCP client starts and owns for the length of a session.

## One tenant, always

The single most important property of this server: **an MCP session sees exactly one tenant.**

The tenant is fixed at process start, from the environment:

```ts
const tenantId = process.env['PASSO_MCP_TENANT_ID'];
if (!tenantId) {
  logger.fatal('PASSO_MCP_TENANT_ID is required for the mcp role — an MCP session is scoped to one tenant');
  process.exit(1);
}
```

Every query the server issues then goes through `withTenant(d.db, d.tenantId, …)` — the same RLS-scoped transaction wrapper the API uses. There is no tool argument that selects a tenant, no way to widen the scope mid-session, and no code path that reaches another tenant's rows.

::: danger Why this matters more here than anywhere else
An LLM with cross-tenant reach would be a data-exfiltration path with a natural-language interface. Not a hypothetical: "summarise all recent rejections" is a perfectly ordinary request that, without scoping, would return other companies' invoice data — and would look like the tool working correctly.

Scoping at process start rather than per call means there is no argument to get wrong, no prompt injection that can widen it, and no tool the model can call to change it. The boundary is outside the model's reach entirely.
:::

## Authentication

Two ways to choose the tenant. **Prefer the key.**

### `PASSO_MCP_KEY` — revocable, scoped, audited

```bash
curl -X POST $PASSO/api/v1/admin/tenants/$TID/mcp-keys \
  -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{ "name": "claude-desktop", "expiresInDays": 90 }'
```

The key is `passo_mcp_…`, shown **once**, stored as a bcrypt hash. It resolves
the tenant *and* carries scopes, so you can hand one assistant read-only access
and another the ability to retry — and revoke either without touching the other.

| | |
|---|---|
| `POST /admin/tenants/{id}/mcp-keys` | Create. Returns the key once |
| `GET /admin/tenants/{id}/mcp-keys` | List — prefix and metadata, never the secret |
| `POST /admin/tenants/{id}/mcp-keys/{keyId}/rotate` | New secret; the old one dies immediately |
| `DELETE /admin/tenants/{id}/mcp-keys/{keyId}` | Revoke |

Rotation has **no overlap window**, unlike webhook secrets: an MCP session
reconnects, it does not need to verify signatures from a past deployment.

### `PASSO_MCP_TENANT_ID` — the self-hosted fallback

```bash
docker compose run --rm -e PASSO_MCP_TENANT_ID=<uuid> mcp
```

Still supported, and honest about what it is: the isolation is real (every query
is RLS-scoped) but the *authority* is "can start this container", not "holds
this credential". It cannot be revoked or scoped. Appropriate when the operator
starts the process themselves; not otherwise.

## Scopes

A key's scopes decide which tools exist for that session. Defaults are
read-mostly — the holder is a language model.

| Default scope | Grants |
|---|---|
| `invoices:read` | `list_submissions`, `get_submission`, `list_pending`, `analyse_failures`, `list_dlq_items` |
| `webhooks:read` | `list_webhooks` |

Opt in explicitly for more:

| Scope | Grants |
|---|---|
| `invoices:write` | `retry_submission` — the only write |
| `keys:read` | `get_api_key_status` (metadata only, never key material) |

::: tip A tool the key cannot call is not LISTED
Offering it would have the model plan around a capability it does not have. And
a call beyond scope is refused with an explanation rather than an empty result —
an empty result would have the model report "there is nothing" to a user.
:::

## Running it

The `mcp` service in `docker-compose.yml` sits behind a profile, so
`docker compose up` never starts it:

```bash
docker compose run --rm -e PASSO_MCP_KEY=passo_mcp_… mcp
```

`--rm` because the process is session-scoped.

Find the tenant id first:

```bash
curl -s localhost:3000/api/v1/admin/tenants \
  -H "authorization: Bearer $PASSO_ADMIN_KEY" | jq -r '.data[] | "\(.slug)\t\(.id)"'
```

::: warning `npm run mcp` omits the tenant id
The package script is `docker compose run --rm mcp` with no `-e`. Without `PASSO_MCP_TENANT_ID` the process logs a fatal and exits. Use the full command above.
:::

### Wiring it to a client

Any MCP client that can launch a stdio subprocess works. The pattern:

```json
{
  "mcpServers": {
    "passo": {
      "command": "docker",
      "args": [
        "compose", "-f", "/path/to/passo/docker-compose.yml",
        "run", "--rm",
        "-e", "PASSO_MCP_TENANT_ID=7a3f0c11-...",
        "mcp"
      ]
    }
  }
}
```

Consult your client's own documentation for where that configuration lives.

The service only depends on Postgres — it does not need RabbitMQ or Redis, because `retry_submission` writes to the outbox and lets the relay do the publishing.

## Tools

Five tools. Four are read-only; one writes, and it is guarded.

### `list_submissions`

Recent submissions, optionally filtered by state.

| Argument | Type | Default |
|---|---|---|
| `state` | string | all states |
| `limit` | number | 20 |

Valid states: `queued`, `transmitted`, `delivered`, `rejected`, `failed`, `awaiting_delivery`. Returns id, state, `progressivo_invio`, channel, `created_at` and invoice number.

### `get_submission`

Full status and notification history for one submission.

| Argument | Type | Required |
|---|---|---|
| `submissionId` | string | yes |

Returns the submission row plus every notification with its `parsed` payload — which for an `NS` includes the full error list.

### `retry_submission`

The one write. Re-enqueues a stalled submission.

| Argument | Type | Required |
|---|---|---|
| `submissionId` | string | yes |

**It refuses NS, MC and other terminal states**, and it explains why rather than returning a bare failure:

```json
{
  "refused": true,
  "reason": "ERR_CONFLICT_NS_RETRY",
  "state": "rejected",
  "explanation": "NS is terminal. The invoice is legally NOT issued. Correct the invoice and submit it as a NEW invoice — PASSO allocates a new ProgressivoInvio. Retrying would send a duplicate to the tax authority."
}
```

For an `MC`:

```json
{
  "refused": true,
  "reason": "ERR_CONFLICT_MC_RETRY",
  "state": "awaiting_delivery",
  "explanation": "MC means SdI is still attempting delivery. The invoice IS legally issued. Resubmitting would duplicate it."
}
```

::: danger Why the refusal is a paragraph, not a status code
This is the mistake integrators make most often, and an LLM is *more* likely to make it, not less.

Everything about an `NS` looks like a retry candidate: it is a failure, it came from an external system, and it has a `retry` endpoint sitting right next to it. A model reasoning from those signals will retry it — that is the locally sensible move. The consequence is a duplicate document at the Italian tax authority.

So the refusal returns a `content` block explaining what `NS` means, why retrying is wrong, and what the correct action is. A model that receives *"NS is terminal. The invoice is legally NOT issued. Correct the invoice and submit it as a NEW invoice"* will not loop on the retry; a model that receives `409` may well try three more times before giving up.

The guard is `canRetry()` in `src/domain/submission/state.ts` — the same function the HTTP route uses. There is no path around it.
:::

A successful retry is written to the audit log with `actor: 'mcp'`, so an LLM-initiated action is distinguishable from an API one in the hash-chained log.

### `list_pending`

Submissions carrying unacknowledged receipts. Capped at 50.

Note this is narrower than the HTTP `GET /pending`: the MCP version requires at least one unacknowledged notification, while the HTTP version *also* includes submissions with no terminal outcome yet.

### `analyse_failures`

Groups recent rejections by SdI error code.

| Argument | Type | Default |
|---|---|---|
| `days` | number | 7 |

```json
{
  "rejections": [
    { "code": "00423", "description": "PrezzoTotale non calcolato correttamente", "occurrences": 47 },
    { "code": "00311", "description": "CodiceDestinatario non valido", "occurrences": 12 }
  ]
}
```

This is the tool that pays for the server. It expands `notifications.parsed->'errors'` with `jsonb_array_elements` and counts by code — turning "invoices keep failing" into "47 of them are one arithmetic bug in the totals". An LLM can go straight from that output to the specific mapping defect.

## Resources

Two, both read-only JSON:

| URI | Contents |
|---|---|
| `passo://submissions` | 100 most recent submissions: id, state, invoice number |
| `passo://audit-log` | 100 most recent audit entries: actor, action, resource, timestamp |

Both are tenant-scoped like everything else. The audit resource is useful for "what changed recently and who did it" — including which actions came from `mcp` versus `api` or `admin`.

## What the LLM cannot see

Worth stating explicitly, because it bounds what you are exposing:

- **No other tenant.** Enforced by RLS on every query.
- **No invoice XML.** No tool returns payload or generated XML.
- **No credentials.** Channel configs, key hashes and webhook secrets are never selected.
- **No key material.** Encryption keys never leave the key provider.
- **No submission creation.** There is no tool to submit an invoice. The only write is a retry of something that already exists.

The exposed surface is: submission metadata, states, notification types, SdI error codes and descriptions, and audit entries. Enough to diagnose; not enough to exfiltrate an invoice.

## Example session

> **You:** Anything stuck for this tenant?

`list_pending` → three submissions with unacknowledged receipts.

> **You:** What's failing lately?

`analyse_failures` with `days: 30` →

```json
{ "rejections": [
  { "code": "00423", "description": "PrezzoTotale non calcolato correttamente", "occurrences": 47 }
]}
```

> **Assistant:** 47 rejections in 30 days, all `00423` — `PrezzoTotale` does not match quantity × unit price. That is one arithmetic bug, not 47 separate problems.

> **You:** Retry the most recent one.

`get_submission` → state is `rejected`. `retry_submission` →

```json
{ "refused": true, "reason": "ERR_CONFLICT_NS_RETRY", "state": "rejected",
  "explanation": "NS is terminal. The invoice is legally NOT issued. …" }
```

> **Assistant:** Retry refused, and correctly so. `NS` is terminal — the invoice is legally not issued, and PASSO will not resubmit it because that would send a duplicate to the tax authority. Fix the `PrezzoTotale` calculation and submit a **new** invoice; it gets a fresh `ProgressivoInvio`.

## Operational notes

**Lifetime.** The process lives as long as the stdio connection. `startMcpStdio` returns without registering shutdown handlers — the transport owns the lifetime, and `docker compose run --rm` removes the container on exit.

**Concurrency.** Each session is its own process with its own connection pool. Several sessions for several tenants can run at once; they share nothing.

**Auditing.** Only `retry_submission` writes an audit entry. Reads are not audited, so the audit log will not show you what an LLM looked at — only what it changed.

**Not a service.** Do not add `mcp` to your default compose profile or give it a restart policy. It is a subprocess, started on demand, scoped to one tenant, and gone when the session ends.

## Prompts

Two named prompts ship with the server, because the model needs the **domain
rules** stated and not just the data.

| Prompt | Purpose |
|---|---|
| `invoice_status_report` | Summarise submissions by status for a period |
| `key_rotation_reminder` | Report keys nearing expiry |

::: warning Why the status prompt spells out NS and MC
A model left to summarise raw statuses will report an NS as *"failed, will
retry"* — which is exactly backwards, and the advice a user would then act on.
The prompt states plainly that NS is terminal and needs a **new** invoice, and
that MC is **not** a failure because the invoice is already legally issued.

Getting this wrong is not a wording problem. It is either a duplicate invoice at
the tax authority or an invoice nobody reissues.
:::

## Limits

| Limit | Value | Why |
|---|---|---|
| Calls per minute | 100 | A model in a retry loop is the realistic failure |
| Concurrent calls | 5 | Uncapped, it exhausts the pool invoice submission needs |
| Per-call timeout | 15 s | A slow query must not hang an assistant indefinitely |

Exceeding a limit is a **refusal with a reason**, not an error — a bare error
would have the model retry immediately, which is how the loop started.

## What never reaches the model

- **Raw invoice XML.** Attachments, counterparty detail and signature material.
- **Any secret.** Webhook signing secrets, channel credentials, key hashes — an
  output filter strips secret-shaped fields regardless of which handler produced
  them, as a last line behind queries already written to avoid them.
- **Quarantined payloads.** Metadata only: a receipt whose owning tenant is
  unknown could belong to anyone.
- **Another tenant's anything.** Enforced by RLS, not by the tool code.
