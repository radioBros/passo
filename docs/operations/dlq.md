# DLQ and quarantine

Two different holding areas, for two different failures.

| | **DLQ** | **Quarantine** |
|---|---|---|
| Holds | Jobs that exhausted their retries | Receipts whose owning tenant is unknown |
| Cause | Our processing failed | The correlation lookup found nothing |
| Risk | A stuck invoice | A **legal receipt** with no home |
| Discard? | Sometimes | **Never** on age alone |

## Inspecting the DLQ

```bash
docker compose exec api ./src/cli/passo-cli.ts dlq list
docker compose exec api ./src/cli/passo-cli.ts dlq list dlq.submit-sdi
```

Each entry carries the stage, the failure reason, the attempt count and the
original envelope.

### Replay versus discard

**Replay** when the cause was environmental — a vendor outage, a broker
restart, a transient timeout:

```bash
docker compose exec api ./src/cli/passo-cli.ts dlq replay dlq.submit-sdi
```

**Do not replay** a job that failed because the document is wrong. It will fail
identically. Fix the invoice and submit a new one.

::: danger Never replay a submission whose invoice was rejected with NS
NS is terminal. Replaying re-sends a document the tax authority has already
refused, and if it somehow succeeds you have a duplicate. The state machine
refuses this through the API; the CLI is a lower-level tool that trusts you.
:::

## Quarantined receipts

A quarantined notification is a receipt PASSO could not match to any submission
— an unknown `IdentificativoSdI`, or a receiver-flow type (MT/EC/SE) that
belongs to a flow PASSO does not yet implement.

```bash
docker compose exec api ./src/cli/passo-cli.ts quarantine list
curl $PASSO/api/v1/admin/quarantine     -H "authorization: Bearer $ADMIN_KEY"
curl $PASSO/api/v1/admin/quarantine/ID  -H "authorization: Bearer $ADMIN_KEY"
```

The listing returns **metadata only**. The raw payload needs the single-item
endpoint, and reading it goes through the dedicated `passo_quarantine` role —
the tenant-scoped role cannot read these rows at all, because a receipt whose
tenant is unknown could belong to anyone.

### Why they are never purged on age

An unresolved quarantined receipt is a legal document whose owner has not been
determined. Deleting it destroys the only copy of something a taxpayer may need.
Only receipts an operator has explicitly **resolved** become purge-eligible, and
only then after the retention window.

## Common causes

| Symptom | Likely cause |
|---|---|
| Many quarantined at once | The correlation record was purged before the receipt arrived — check `CORRELATION_RETENTION_DAYS` |
| MT / EC / SE quarantined | Expected. These belong to the inbound-reception flow, not the transmitter flow |
| A single unknown `IdentificativoSdI` | A receipt for an invoice submitted by a different system through the same channel |

## Alerting

Two signals worth alerting on:

- **DLQ depth increasing** — jobs are failing faster than they are cleared.
- **`INGRESS STALLED`** in the worker log — the PEC poller has not completed a
  cycle. Distinct from SdI being slow, which is logged at `warn` and is normal.
