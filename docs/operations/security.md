# Security

PASSO handles tax documents, PEC mailbox credentials and vendor API keys for several organisations at once. This page describes the controls it ships and — just as important — where their limits are.

::: danger PASSO is not SOC 2 certified, and cannot be
SOC 2 audits **an organisation's** service delivery — its people, processes and operational controls over a defined period. It does not audit software.

PASSO is software. It carries no SOC 2 report, no ISO certification and no tax-authority approval, and any claim otherwise is false.

Only **you**, as the operator, can hold a SOC 2 report for your deployment. What PASSO ships is the technical control set that makes such an audit passable: encryption at rest, tenant isolation, a tamper-evident audit log, secret redaction, least-privilege database roles. The organisational half — access reviews, change management, incident response, vendor management — is yours.

PASSO is also not an accredited SdI intermediary, does not perform *conservazione a norma*, and does not give tax advice. See [What PASSO is not](/guide/scope).
:::

## Encryption at rest

Everything sensitive is encrypted with **AES-256-GCM** before it reaches a column:

| Table | Column | Contents |
|---|---|---|
| `invoices` | `payload_encrypted` | The caller's original invoice JSON |
| `sdi_submissions` | `xml_encrypted` | The generated FatturaPA XML |
| `notifications` | `raw_encrypted` | The raw SdI notification |
| `webhooks` | `secret_encrypted` | The HMAC signing secret |
| `channel_credentials` | `config_encrypted` | PEC passwords, vendor API keys |

GCM is authenticated encryption: each row stores a 12-byte IV, a 16-byte auth tag and the key version alongside the ciphertext. Tampering with the ciphertext fails decryption rather than yielding altered plaintext.

### AAD binds ciphertext to its tenant and column

```ts
function aad(tenantId: string, column: string): Buffer {
  return Buffer.from(`${tenantId}:${column}`, 'utf8');
}
```

Additional Authenticated Data is not encrypted, but it is covered by the auth tag — decryption fails unless the same AAD is supplied.

This closes an attack that encryption alone does not. Consider someone with **database write access** but no key:

```sql
-- Copy tenant A's channel credentials onto tenant B's row
UPDATE channel_credentials
   SET config_encrypted = (SELECT config_encrypted FROM channel_credentials WHERE tenant_id = 'A'),
       config_iv = ..., config_tag = ...
 WHERE tenant_id = 'B';
```

Without AAD this works. The ciphertext is valid, the tag matches, and tenant B's worker now decrypts and uses tenant A's PEC credentials — transmitting under A's identity.

With AAD, decryption is attempted with `B:channel_config` while the tag was computed over `A:channel_config`. It fails. The same applies across *columns*: an XML blob cannot be transplanted into a webhook-secret field.

::: tip This defends a threat model most encryption-at-rest does not
Standard column encryption protects against a stolen backup or disk. AAD binding additionally protects against someone who can **write** to the database but cannot read keys — a compromised admin connection, an injection reaching an UPDATE, a malicious operator on a shared host.
:::

## Key management

### The provider interface

```ts
export interface KeyProvider {
  getActiveKey(): KeyMaterial;
  getKeyByVersion(version: string): KeyMaterial;
  listVersions(): string[];
}
```

Three methods. Encryption always uses the active key; decryption always looks up the version recorded on the row.

::: warning One implementation ships: `EnvKeyProvider`
`KeyProvider` is an interface, and a Vault or KMS backend can be written against it — but no such implementation is in this repository. The environment-variable provider is what you get.

Do not read "pluggable key provider" as "Vault support included". The seam exists; the alternative implementation does not.
:::

### The env provider

Keys come from `PASSO_ENCRYPTION_KEY_<VERSION>` (base64, exactly 32 bytes) plus `PASSO_ENCRYPTION_KEY_ACTIVE` naming the current version:

```bash
PASSO_ENCRYPTION_KEY_V1=Zm9vYmFyYmF6cXV4...   # 32 bytes, base64
PASSO_ENCRYPTION_KEY_ACTIVE=v1
```

Validation is strict and happens at construction:

- A key that does not decode to exactly 32 bytes raises `KeyError`.
- A missing `PASSO_ENCRYPTION_KEY_ACTIVE` raises — *"refusing to start rather than store plaintext"*.
- An active version with no matching key raises.

There is no default and no generated fallback. A generated secret ends up in shell history and log files, and worse, produces a working system whose data becomes unreadable on the next restart.

### `PASSO_KEY_FILE`

Keys may also come from a file of `version=base64` lines:

```bash
PASSO_KEY_FILE=/run/secrets/passo-keys
```

```
v1=Zm9vYmFyYmF6cXV4...
v2=YmFyYmF6cXV4Zm9v...
```

**Permissions are enforced.** The file must be `0600` or stricter:

```ts
const mode = statSync(file).mode & 0o077;
if (mode !== 0) throw new KeyError(`${file}: permissions must be 0600 or stricter`);
```

A world-readable key file is refused at startup rather than quietly accepted.

::: danger The env provider's limitation, stated plainly
With `EnvKeyProvider`, **anyone who can read the process environment or take a memory dump can read the key.** That includes a root user on the host, another container with access to `/proc`, and anyone who can run `docker inspect`.

This is a deliberate trade. Requiring Vault or a cloud KMS to run PASSO at all would contradict the self-hosted premise — the operator already controls the host, the process and the database.

Operators handling higher-sensitivity data should implement a Vault or KMS provider behind the `KeyProvider` interface. The seam is there for exactly this.
:::

### Rotation

Old key versions **stay resolvable**:

```ts
getKeyByVersion(version: string): KeyMaterial {
  const key = this.keys.get(version.toLowerCase());
  // Retired keys stay resolvable so historical rows remain decryptable.
  if (!key) throw new KeyError(`unknown key version "${version}" — cannot decrypt`);
  return { version: version.toLowerCase(), key };
}
```

Every encrypted row records the version that encrypted it, so rows written under `v1` keep decrypting after `v2` becomes active.

To rotate:

1. Generate a new key: `openssl rand -base64 32`
2. Add `PASSO_ENCRYPTION_KEY_V2=<new>` — **keep `V1` in place**
3. Set `PASSO_ENCRYPTION_KEY_ACTIVE=v2`
4. Restart

New writes use `v2`. Existing rows keep decrypting under `v1`.

::: warning There is no re-encryption command
Nothing in this build walks the tables and re-encrypts old rows under the new key. Old ciphertext stays under its original version indefinitely.

That is workable for a relay — payloads are purged once terminal, so `v1` rows drain naturally — but it has two consequences:

1. **You cannot retire an old key** until every row encrypted under it is gone. Removing `PASSO_ENCRYPTION_KEY_V1` too early makes those rows permanently unreadable, and they will raise `unknown key version "v1" — cannot decrypt` on access.
2. **Rotation does not remediate a compromised key.** It stops *new* data being encrypted under it; it does nothing for data already written.

Long-lived rows — `channel_credentials` and `webhooks` in particular — are not purged by retention and will sit on the old version until rewritten. Re-`PUT` a channel config and re-register webhooks after rotation to move them forward.
:::

There is an `encryption_keys` table, but it holds **metadata only** — version, algorithm, state, timestamps. Key material never touches the database. Storing keys next to the ciphertext they protect defeats the point of encrypting.

## Tenant isolation

Fourteen tables carry `FORCE ROW LEVEL SECURITY` with both `USING` and `WITH CHECK` predicates. The application role is `NOSUPERUSER NOBYPASSRLS`, so the policy applies to it.

Four narrowly-scoped `BYPASSRLS` roles exist for lookups that genuinely cannot know their tenant in advance — `passo_auth` (authentication), `passo_router` (receipt routing), `passo_relay` (the outbox) and `passo_purge` (retention). Each reads a minimal view, not a base table.

Cross-tenant references are prevented structurally with composite `(tenant_id, id)` foreign keys, because RLS filters *rows* and says nothing about what those rows *point at*.

This is covered in full — including why each bypass is unavoidable and what each view exposes — in [Multi-tenancy](/guide/tenancy). It is the single most important isolation control in the system.

### Quarantine containment

A fifth role, `passo_quarantine`, solves the inverse problem and is **not** `BYPASSRLS`.

A quarantined notification is a receipt whose owning tenant could not be determined. `quarantined_notifications` therefore has no `tenant_id` column, no RLS policy, and **no possible policy** — there is nothing to scope by. That is correct by design, and it made the table a cross-tenant hole: `passo_app`, the tenant-scoped application role, held full `SELECT` and could read every tenant's raw fiscal receipt regardless of tenant context.

Since RLS cannot help, containment comes from grants:

```sql
REVOKE ALL   ON quarantined_notifications FROM passo_app;
GRANT INSERT ON quarantined_notifications TO   passo_app;
GRANT SELECT, UPDATE ON quarantined_notifications TO passo_quarantine;
GRANT passo_quarantine TO passo_app;
```

::: tip Writing is not reading
`passo_app` keeps `INSERT` and loses `SELECT`. The ingest path must still be able to quarantine an unmatched receipt — but it has no business reading one back.

The role is `NOINHERIT`, so `passo_app` holding membership does not silently acquire its privileges. It must be assumed deliberately with `SET LOCAL ROLE passo_quarantine`, which is what `withQuarantineRole` does for the two operator surfaces that need it.
:::

A metadata-only view, `quarantine_index`, carries the routine listing **without the `raw` column**. Listing orphaned receipts is a routine operator action; reading a stranger's fiscal payload is not, and the two do not share a query. Fetching a raw payload is an explicit, single-row, admin-authenticated act — `GET /admin/quarantine/{id}`.

Note that `raw` is stored as plain `text`, not encrypted: a tenant-bound AAD cannot be constructed when the tenant is unknown. The grant-based containment is what protects it.

## The hash-chained audit log

```ts
const hash = createHash('sha256').update(`${prevHash ?? ''}${payload}`).digest('hex');
```

Each row's hash covers **the previous row's hash** plus its own payload. Rows store both `prev_hash` and `hash`.

### What a chain detects that per-row hashing does not

A per-row hash — `hash = H(this row)` — detects **edits only**. An attacker who modifies a row breaks its hash, so that is caught. But:

| Attack | Per-row hash | Hash chain |
|---|---|---|
| Edit a field | ✅ detected | ✅ detected |
| **Delete a row** | ❌ invisible | ✅ detected |
| **Reorder rows** | ❌ invisible | ✅ detected |
| **Insert a backdated row** | ❌ invisible | ✅ detected |

Deletion is the one that matters. An attacker who does something they want hidden does not edit the record of it — they **remove** it. With per-row hashes, every remaining row still validates perfectly, and the log looks pristine.

With a chain, deleting row *N* orphans row *N+1*: its `prev_hash` points at a hash that no longer appears. The break is detectable, and it localises to the deletion point.

The same applies to reordering — the chain encodes sequence — and to insertion, since a new row cannot produce a `prev_hash` that matches without also rewriting everything after it.

### Verifying

```bash
passo-cli audit verify <tenantId>
curl localhost:3000/api/v1/admin/tenants/$TENANT/audit/verify -H "authorization: Bearer $ADMIN"
```

```json
{ "ok": true }
{ "ok": false, "brokenAtId": "4471" }
```

The CLI exits non-zero on failure, so it works from cron.

::: warning What a per-tenant verification actually proves
The chain is **global** across the instance — a row's `prev_hash` may belong to another tenant's row. But `audit_log` is tenant-scoped, so verification sees only your rows.

`verifyAuditChain(tenantId)` therefore checks the links **between rows you can see**, and proves your rows form an unbroken subsequence. That is exactly what detects a deletion among them.

It cannot prove anything about other tenants' rows, and it deliberately does not treat the first visible row's `prev_hash` as a failure — that link points into a row RLS hides.

Full-instance verification is an operator task run with elevated privileges against the whole table.
:::

::: danger A broken chain is an incident
The chain does not break by accident. Application code never updates or deletes audit rows; the purge job deletes only rows older than `AUDIT_RETENTION_MONTHS`, which breaks the chain at the boundary by design.

An `ok: false` at any other point means someone with database access modified the log. Investigate before doing anything else.
:::

Two things weaken the guarantee, and both are worth stating:

- **`passo_purge` holds `DELETE` on `audit_log`.** Retention pruning needs it. Anyone who can assume that role can delete audit rows — verification will detect it, but cannot prevent it.
- **The hash chain is not a signature.** Someone with write access to the whole table can recompute every hash forward from a tampered row and produce a chain that validates. Detecting *that* requires anchoring the chain somewhere PASSO does not control — periodically recording the latest hash off-host. PASSO does not do this; an operator can.

Every entry records the actor: `api`, `admin`, `mcp`, `worker`, `purge-job` or `channel:<name>`.

## SSRF protection on webhook URLs

A webhook URL is caller-supplied and PASSO fetches it from inside your network. Unprotected, that is a server-side request forgery primitive pointed at everything the container can reach.

### Blocked ranges

```ts
const BLOCKED_V4 = [
  [0x00000000, 0xff000000],   // 0.0.0.0/8
  [0x7f000000, 0xff000000],   // 127.0.0.0/8      loopback
  [0x0a000000, 0xff000000],   // 10.0.0.0/8       private
  [0xac100000, 0xfff00000],   // 172.16.0.0/12    private
  [0xc0a80000, 0xffff0000],   // 192.168.0.0/16   private
  [0xa9fe0000, 0xffff0000],   // 169.254.0.0/16   link-local — CLOUD METADATA
  [0x64400000, 0xffc00000],   // 100.64.0.0/10    CGNAT
];
```

IPv6 blocks `::1`, `::`, unique-local (`fc00::/7`), link-local (`fe80::/10`), and recurses into IPv4-mapped addresses (`::ffff:127.0.0.1`).

`169.254.0.0/16` is the one that matters most. `169.254.169.254` is the cloud metadata endpoint on AWS, GCP and Azure — a URL that, on many deployments, returns instance credentials to anything that asks.

Anything that is not a valid IP is blocked outright (`return true`).

Also refused: non-HTTPS URLs (HTTP is permitted only when `NODE_ENV` is not `production`), and URLs carrying credentials in the userinfo component.

### DNS rebinding, and what PASSO actually does about it

Blocking by hostname alone loses to a trivially simple attack:

1. Register `https://evil.example.com/hook`. It resolves to a public IP. Validation passes.
2. Change the DNS record to `169.254.169.254`, with a short TTL.
3. PASSO delivers a webhook — and now resolves the private address.

The check ran against one answer; the request used another.

`validateWebhookUrl` resolves the hostname and checks the **resolved address**, returning it to the caller:

```ts
let addr: { address: string };
try { addr = await lookup(host); }
catch { throw new SsrfError(`callback host does not resolve: ${host}`); }
if (isBlockedIp(addr.address)) {
  throw new SsrfError(`callback host resolves to a blocked address: ${addr.address}`);
}
return { url, ip: addr.address };
```

And the dispatcher re-validates immediately before every single send, not just at registration:

```ts
// Re-validate at send time: a hostname that resolved public at
// registration can resolve private now (DNS rebinding).
const { url } = await validateWebhookUrl(h.url, { allowHttp });
const res = await fetch(url, { /* … */ });
```

::: warning The resolved IP is returned but not used to connect
`validateWebhookUrl` hands back a pinned `ip`, but the dispatcher calls `fetch(url, …)` — by **hostname**. Node resolves the name again for the actual connection.

So the window between the validating lookup and the connecting lookup is not closed; it is narrowed to milliseconds, and only by re-validating on every send.

Fully closing it means connecting to the checked address directly — a custom agent that dials the pinned IP while preserving the `Host` header and SNI for TLS. That is not implemented here.

In practice the narrow window plus per-send re-validation defeats the ordinary rebinding attack, which relies on a long gap between registration and delivery. It does not defeat an attacker who can win a millisecond-scale race against your resolver.
:::

## XXE prevention

Notification XML arrives from outside — over PEC it is an email attachment from an unauthenticated sender. Every parse disables external entities:

```ts
doc = libxml.parseXml(xml, {
  noent: false,    // do NOT expand entities (XXE defence)
  nonet: true,     // no network fetch for external entities
  dtdload: false,  // do not load external DTD
  dtdvalid: false,
  noblanks: false,
});
```

Without these, a classic XXE reads local files:

```xml
<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<RicevutaConsegna><NomeFile>&xxe;</NomeFile></RicevutaConsegna>
```

Or exfiltrates via a parameter entity, or wedges the parser with a billion-laughs expansion.

The same options are applied in three places — `parser.ts` for notifications, `xsd.ts` for both schema loading and document validation. Every one of them.

`nonet: true` also matters for a reason unrelated to security: the FatturaPA XSD imports the W3C xmldsig schema from a `w3.org` URL upstream. PASSO **vendors** that file and rewrites the import to a relative path, so schema compilation never touches the network. Without it, every submission would depend on w3.org being reachable.

XSLT rendering runs `xsltproc --nonet` as a subprocess, with a timeout (`PASSO_RENDER_TIMEOUT_MS`), an output cap (`PASSO_MAX_RENDER_BYTES`) and `--maxdepth 2000` against recursive expansion.

## Webhook signing

```
X-Passo-Signature: t=1756713600,v1=8a3f2b1c...
```

HMAC-SHA256 over `"<timestamp>.<rawBody>"`, with the secret generated at registration and encrypted at rest.

Including the timestamp inside the signed payload is what makes the replay window enforceable — an attacker cannot keep a captured body valid by adjusting the header, because the timestamp is part of what was signed.

### The `timingSafeEqual` trap

```ts
const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
const received = Buffer.from(v1, 'hex');
if (expected.length !== received.length) return false;   // ← REQUIRED
return timingSafeEqual(expected, received);
```

::: danger `timingSafeEqual` throws on unequal lengths
It does not return `false` — it raises `RangeError: Input buffers must have the same byte length`.

So the naive implementation:

```ts
return timingSafeEqual(expected, Buffer.from(v1, 'hex'));   // ✗
```

**crashes** on a malformed signature instead of rejecting it. If that runs inside an Express handler without a catch, it is a `500`. If it runs inside a `try` that logs and continues, the outcome depends entirely on what the catch block does — and a catch block written for network errors may well return `true`-ish.

An attacker sending a one-byte `v1` should get a clean rejection, not an exception path nobody tested.

It also throws on **strings**. Both arguments must be Buffers.
:::

There is a second, quieter trap in the same function:

```ts
if (!t || !v1 || !/^[0-9a-f]*$/i.test(v1)) return false;
```

`Buffer.from(v1, 'hex')` silently truncates at the first non-hex character. `Buffer.from('zz', 'hex')` is a **zero-length buffer** — so without the hex check, a garbage signature produces an empty buffer whose length happens to differ, and you are relying on the length check to catch what should have been rejected as malformed input.

### Replay window

```ts
if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;   // 300s default
```

Five minutes, checked with `Math.abs` so both future and past timestamps are bounded.

### Verify over raw bytes

Compute the HMAC over the **raw body bytes**, before any JSON parsing. Re-serialising parsed JSON changes key order, whitespace and number formatting — the signature will not match, and the failure looks like a secret mismatch rather than a serialisation difference.

In Express, capture the raw body with a `verify` callback on the JSON parser.

A full reference implementation is in [Notifications & webhooks](/api/webhooks).

## API key security

| Control | Detail |
|---|---|
| Storage | bcrypt, cost 12. The plaintext is never stored |
| Display | Returned once at creation; unrecoverable afterwards |
| Comparison | bcrypt, constant-time internally. Never string-compared |
| Lookup | Narrowed by 16-character prefix, then bcrypt over candidates |
| Rotation | New key issued; old valid 7 days |
| Revocation | Immediate, no grace |
| Suspension | A suspended tenant's keys stop resolving at the view level |

The admin key is compared with `timingSafeEqual` — with the same mandatory length check first:

```ts
export function checkAdminKey(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual THROWS on unequal lengths — check length first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

::: warning The length check leaks length, and that is fine
Returning early on a length mismatch reveals whether the presented key is the right *length*. That is an acceptable disclosure — key length is not secret, and the alternative is an exception.
:::

## HTTP hardening

The API sets restrictive headers via `helmet`:

- **CSP**: `default-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`, `sandbox`. PASSO is a JSON/XML API and never a browser document surface, so the policy denies everything rather than allowing a curated set.
- **HSTS**: emitted when `PASSO_HSTS_MAX_AGE > 0` (default one year, `includeSubDomains`). Set it to `0` for plain-HTTP local development, where the header would pin a browser to a scheme the dev stack does not serve.
- `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`.
- `x-powered-by` and ETags disabled.

**CORS is off by default** — no headers at all. A browser origin has no business holding a CRM's API key. An operator opts in with an explicit allowlist in `PASSO_CORS_ORIGINS`; the wildcard combined with `PASSO_CORS_CREDENTIALS=true` is refused at boot, because browsers reject that pair and an operator who sets it believes cross-origin auth works.

## Rate limiting

100 requests per 60 seconds per API key, Redis-backed when available.

It distinguishes a spent budget from a broken store and **fails open** on the latter: Redis holds nothing whose loss may block an invoice, and collapsing both into a `429` would let a cache blip halt submission for every tenant at once. A failed-open request carries `x-ratelimit-bypassed: store-unavailable`.

::: warning Rate limiting is not the DoS control you might assume
Limits are per key, not per tenant or per IP. Unauthenticated requests fall back to the client IP.

Without Redis the limiter is per process, so `N` replicas allow `N × 100`. And `RATE_LIMIT_POINTS` / `RATE_LIMIT_DURATION_SEC` in `.env.example` are **not read** — the 100/60 values are compiled in. See [Configuration](/reference/configuration).
:::

## Secret redaction in logs

```ts
export const REDACT = [
  'req.headers.authorization', 'req.headers.cookie', 'headers.authorization',
  'apiKey', 'api_key', 'key', 'keyHash', 'secret', 'secretEncrypted', 'password',
  'PASSO_ADMIN_KEY', 'DATABASE_URL', 'RABBITMQ_URL',
  '*.password', '*.secret', '*.apiKey', '*.token',
  'config.password', 'credentials', 'smtpPassword', 'pecPassword',
];
```

Applied by `pino` at **every** level, including `trace`. Redacted values become `[redacted]`.

The list covers both PASSO's own field names and the header and connection-string shapes that carry credentials. `DATABASE_URL` and `RABBITMQ_URL` are there because they embed passwords, and a connection string in a log line is a credential in a log line.

Boot-time config validation follows the same rule:

```ts
// Never echo the values — only which variables are wrong.
throw new Error(`Invalid configuration:\n${problems}`);
```

You learn *which* variable failed, never what it was set to.

::: warning Redaction is a denylist
A field name not on the list is logged in full. If you add a feature that handles a new kind of secret, add its field name to `REDACT` in the same change.
:::

## Data minimisation

The strongest control on this page is not cryptographic. PASSO **does not keep the data**.

Once a terminal receipt arrives, the payload and generated XML are purged. What survives is a correlation record holding identifiers and status:

```
tenant_id · submission_id · crm_invoice_ref · progressivo_invio
transmitter_id · identificativo_sdi · pec_message_id · status · timestamps
```

No party names. No addresses. No amounts. No VAT numbers. No XML.

A breach of a long-running PASSO instance exposes in-flight invoices and a list of opaque identifiers — not an archive. This is also what keeps PASSO out of scope for the 10-year retention and *conservazione* obligations. See [Database schema](/reference/schema).

## Deployment responsibilities

PASSO ships controls. These are yours:

1. **Do not publish database ports.** The Compose file binds `0.0.0.0` by default; bind loopback or remove the mappings.
2. **Terminate TLS in front of the API.** Nothing in the stack does it, and both API keys and invoice payloads cross it.
3. **Protect the encryption keys.** With `EnvKeyProvider` they are readable by anyone who can read the process environment. Use a secrets manager, mount them as a `0600` file via `PASSO_KEY_FILE`, or implement a KMS provider.
4. **Back up the keys with the database.** A database backup without key material restores unreadable ciphertext. See [Backup & restore](/operations/backup).
5. **Ship logs off-host** and monitor for `ERR_AUTH_*` bursts, `audit verify` failures and `x-ratelimit-bypassed`.
6. **Verify the audit chain on a schedule.** `passo-cli audit verify` exits non-zero on failure.
7. **Rotate keys and credentials** on a policy you define — PASSO enforces no schedule.
8. **Review the privileged roles** if you customise the schema. Six exist — `passo_app` plus four `BYPASSRLS` roles and the `NOINHERIT` `passo_quarantine` — each narrowly granted. A seventh should be held to the same standard.

## Known limitations

Stated so they are not discovered later:

| Limitation | Impact |
|---|---|
| Env key provider | Key readable from process environment or a memory dump |
| No re-encryption command | Old rows stay on old key versions; rotation does not remediate a compromise |
| Audit chain not anchored externally | Detects tampering by someone who cannot rewrite the whole table; an attacker with full write access can recompute it |
| `passo_purge` can DELETE audit rows | Retention needs it; detectable but not preventable |
| Webhook IP resolved but not pinned for the connection | Rebinding window narrowed to milliseconds, not closed |
| Rate limits compiled in | `RATE_LIMIT_*` variables are inert |
| No mTLS to vendors | Bearer tokens over TLS only |
| No IP allowlisting on API keys | A stolen key works from anywhere |
