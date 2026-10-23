# Operator Runbook

PASSO is API-only. Everything below is available through the Admin API; `passo-cli` is a thin wrapper.

## Key management

```bash
passo-cli key create <tenantId> <name>    # shown ONCE
passo-cli key rotate <tenantId> <keyId>   # old key valid 7 more days
passo-cli key revoke <tenantId> <keyId>   # immediate, no grace
```

## A submission is stuck

```bash
curl localhost:3000/api/v1/invoices/<id> -H "authorization: Bearer <key>"
```

| State | Meaning | Action |
|---|---|---|
| `queued` | Not yet picked up | Check the worker is running and the relay is draining |
| `transmitting` | In flight to the channel | Wait; it retries with backoff |
| `awaiting_delivery` | **MC** — SdI still delivering | **Nothing.** Resubmitting duplicates it |
| `rejected` | **NS** — refused by SdI | Fix and submit a **new** invoice |
| `failed` | Never reached SdI | Inspect the DLQ |

## Dead letters and quarantine

```bash
passo-cli dlq list
passo-cli dlq replay dlq.submit-sdi
passo-cli quarantine list       # notifications that matched no submission
```

Quarantined notifications are **never discarded** — over PEC the mailbox is the only copy of a legal receipt.

## Audit chain

```bash
passo-cli audit verify <tenantId>
```

The log is hash-chained: each row's hash covers the previous one, so deletion and reordering are detectable, not just field edits. A non-`ok` result means the chain was broken — investigate before anything else.

## Purge

```bash
passo-cli purge run
```

Runs hourly on its own. Purges payloads once terminal, receipts once acknowledged plus a grace window, correlation records past ~90 days.

**An unacknowledged receipt is never purged, regardless of age** — enforced by a database constraint, not only by application code.

## Retries are not working

Check the delayed-message plugin first:

```bash
docker compose exec rabbitmq rabbitmq-plugins list -e | grep delayed
```

Without it, an `x-delayed-message` exchange cannot be declared and backoff degrades to immediate redelivery — which looks like "retries are too aggressive", not "a plugin is missing". PASSO logs an error at boot when it detects this.

## Backups

Postgres holds the only irreplaceable state. **Back up the encryption keys too** — a database backup without key material restores unreadable ciphertext.

Test the restore. An untested backup has never been shown to work.
