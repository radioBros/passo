# Security policy

PASSO handles tax documents, PEC mailbox passwords and vendor API keys for multiple organisations on one instance. Treat a leak as an incident at the tenant whose credential escaped, not as a documentation issue.

## Supported versions

| Version | Supported |
|---|---|
| 1.x | Yes |
| < 1.0 | No — rewrite history, do not run it |

## How to report

**Do not open a public issue** for a vulnerability.

Use GitHub's private advisory form:

**https://github.com/radioBros/passo/security/advisories/new**

Include:

- Affected version / commit
- What an attacker can do (tenant isolation bypass, secret recovery, SSRF, forged webhook, duplicate transmission to SdI, …)
- Reproduction that does **not** require real SdI credentials or real invoices
- Whether you believe production deployments are exposed

We will acknowledge the report and work on a fix before any disclosure.

## What is not a vulnerability

- Missing accreditation, certification, or *conservazione a norma* — PASSO does not claim these. See [scope](docs/guide/scope.md).
- A vendor (OpenAPI.it, PEC provider) outage or empty wallet.
- Using `mock` in production — that is an operator misconfiguration; the docs warn against it.
- Pointing `DATABASE_URL` at the admin role — that disables RLS; do not do it.

## Operator checklist after a suspected leak

1. Rotate the affected tenant's API keys and webhook secrets (`POST /webhooks/{id}/rotate-secret`).
2. Change PEC mailbox passwords at the provider — PASSO cannot revoke a mailbox password.
3. Rotate vendor tokens at OpenAPI.it (or the other vendor).
4. Rotate `PASSO_ADMIN_KEY` and encryption keys if the host was compromised; restart the stack.
5. Run `passo-cli audit verify <tenant-id>` and inspect `passo-cli dlq list`.

Operational controls: [Security](docs/operations/security.md).
