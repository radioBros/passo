# Data protection and the storage boundary

This page states exactly what PASSO holds, for how long, and who is responsible
for what. It is written for a reader completing a ROPA entry or a vendor
assessment, and it should answer their questions without a follow-up call.

::: warning What this page is not
PASSO holds **no certification**. It is not ISO 27001 certified, not SOC 2
attested, and not an accredited SdI intermediary. The controls described here are
implemented and tested, but no third party has audited them. Anyone telling you
otherwise is wrong.
:::

## The one-sentence version

**PASSO is a relay, not an archive.** It holds an invoice only long enough to
transmit it and match the receipt that comes back; the CRM is the system of
record and the only place a document lives for the long term.

## Roles under GDPR

| Party | Role | Why |
|---|---|---|
| **The CRM operator** | Controller | Decides that an invoice is issued, to whom, and on what terms |
| **The PASSO operator** (self-hoster) | Processor | Runs the relay on the controller's instruction |
| **The channel vendor / PEC provider** | Sub-processor | Carries the document to SdI |
| **Agenzia delle Entrate (SdI)** | Independent controller | Receives it under its own statutory mandate, not on anyone's instruction |

That last row matters: once a document reaches SdI, no contractual arrangement
between the CRM and PASSO governs it any more. SdI's retention is set by Italian
law, and neither an erasure request nor a deletion in PASSO reaches it.

## What is stored, and for how long

| Data | Where | Lifetime | Notes |
|---|---|---|---|
| Invoice XML | `sdi_submissions.xml_content` | Until a **terminal receipt** arrives, then purged | AES-256-GCM encrypted, AAD-bound to tenant and column |
| Correlation record | `correlation_records` | `CORRELATION_RETENTION_DAYS` (default **90**) | **Identifiers and status only** — no fiscal or personal data |
| Receipts | `notifications` | Purged with their submission | The routed, parsed notification |
| Unmatched receipts | `quarantined_notifications` | Until resolved by an operator | Tenant could not be determined; readable only under `passo_quarantine` |
| Channel credentials | `channel_credentials` | Until the tenant removes them | Encrypted; PEC entries are **passwords**, not revocable tokens |
| Audit log | `audit_log` | `AUDIT_RETENTION_MONTHS` (default **12**) | Hash-chained; see below |
| Tenant and seller config | `tenants`, `sellers` | Until deleted by the operator | Company identity, not counterparty data |

Once purged, the invoice is **gone from PASSO**. A `GET` for a purged submission
returns `410 Gone` — deliberately distinct from `404`, so a CRM can tell "never
existed" from "existed and is no longer here".

::: danger Fetch before purge
PASSO is not a retrieval service for old invoices. If the CRM needs the XML, it
must fetch it **before** the terminal receipt triggers the purge. There is no
recovery path afterwards, by design — that absence is what keeps PASSO outside
the *conservazione a norma* obligation.
:::

## What is deliberately **not** stored

- No invoice archive, and therefore no *conservazione a norma* role — that
  obligation belongs to the CRM or its appointed conservation provider.
- No buyer or seller personal data in the correlation record. It carries
  identifiers and a status, which is the minimum needed to route a late receipt.
- No plaintext credentials anywhere.
- No invoice content in logs. Redaction paths cover authorization headers, API
  keys, webhook secrets, channel credentials, and fiscal identifiers.

## Erasure requests

The answer depends on where the document is:

- **Nothing in flight.** PASSO holds no personal data for that subject beyond
  configuration. The request belongs with the CRM, which controls the archive.
- **A document in flight.** Erasure is refused for the duration of the
  transmission, with the reason stated and **the expected purge point given**.
  The document is already on its way to a tax authority; deleting PASSO's copy
  mid-flight would orphan the receipt without recalling anything.
- **Audit entries.** Refused. The log is hash-chained precisely so entries cannot
  be removed without detection; it expires on its own schedule
  (`AUDIT_RETENTION_MONTHS`).

PASSO does **not** cite Art. 2220 of the Civil Code or a 10-year retention
obligation for invoice data. It holds no such obligation, because it keeps no
archive.

## Integrity controls

**The audit log is hash-chained.** Each row's hash covers the previous row's, so
deleting or reordering entries is detectable — a per-row hash would only catch
edits to a single field.

::: tip Scope of a per-tenant verification
The chain is global while `audit_log` is tenant-scoped, so verifying one tenant
proves that tenant's entries form an unbroken *subsequence*. Whole-chain
verification requires a cross-tenant read. Check it with:

```bash
passo-cli audit verify <tenant-id>
```
:::

**Tenant isolation is enforced by the database, not by application code.** Every
tenant-scoped table has RLS `ENABLE` **and** `FORCE` with both `USING` and
`WITH CHECK`. Missing tenant context returns zero rows rather than raising — a
policy that fails closed. Cross-tenant references are blocked by composite
`(tenant_id, id)` foreign keys, because RLS protects rows but not the references
between them.

**Privileged roles must be assumed, never inherited.** The five bypass roles
(`passo_router`, `passo_relay`, `passo_purge`, `passo_auth`, `passo_quarantine`)
are granted `WITH INHERIT FALSE`, so a privilege is unreachable until code
deliberately assumes it with `SET LOCAL ROLE`. Each is scoped to a narrow view
that carries identifiers and status, never invoice content.

## Sub-processors

Whichever channel a tenant configures becomes a sub-processor:

| Channel | What it sees |
|---|---|
| PEC (own mailbox) | The full invoice, as an email attachment |
| Invoicetronic | The full invoice, via API |
| OpenAPI.it | The full invoice, via API |

Their retention, location and terms are **theirs**, not PASSO's. A controller
completing a ROPA must name the chosen channel and consult that vendor's terms
directly — PASSO cannot make representations on their behalf.

## Encryption

- **At rest**: AES-256-GCM with AAD binding each ciphertext to its tenant *and*
  its column, so a ciphertext moved between rows or columns fails to decrypt.
- **Keys**: environment variables, behind a `KeyProvider` interface. A Vault or
  cloud-KMS provider can be implemented against that interface, but **neither
  ships today** — the env provider is the only one implemented. Its limitation is
  explicit: anyone who can read the process environment can read the keys, so
  higher-sensitivity deployments should supply a provider backed by a KMS.
- **Rotation**: lazy, not bulk. A new version encrypts new writes while old rows
  stay readable under the version that wrote them.
- **In transit**: HTTPS for API channels; PEC uses TLS-protected IMAP and SMTP.

## See also

- [What PASSO is not](/guide/scope) — the scope boundary in plain terms
- [Security](/operations/security) — the control set an operator runs
- [Multi-tenancy](/guide/tenancy) — how isolation is enforced
