# Sizing

Measured on a running stack, not estimated. Reproduce with
`docker stats --no-stream`.

## Idle footprint

| Service | Memory (idle) | Notes |
|---|---|---|
| `api` | ~104 MB | Node heap plus the compiled XSD schemas |
| `worker` | ~104 MB | Same image; also holds the XSLT subprocess |
| `relay` | ~101 MB | Same image, smallest working set |
| `rabbitmq` | ~159 MB | Erlang VM; grows with queue depth |
| `postgres` | ~45 MB | Rises with `shared_buffers` |
| `redis` | ~10 MB | Rate-limit counters and sync-mode pub/sub only |
| **Total** | **~520 MB** | |

CPU is effectively zero at idle across all six.

## Minimum host

| | vCPU | RAM | Disk |
|---|---|---|---|
| **Evaluation** | 2 | 2 GB | 20 GB |
| **Production, < 1k invoices/month** | 2 | 4 GB | 40 GB |
| **Production, ~10k invoices/day** | 4 | 8 GB | 100 GB + backups |

The floor is RAM, not CPU: the six services need ~520 MB before doing any work,
and Postgres wants room for `shared_buffers` on top. 2 GB is workable; 1 GB is
not.

## Images

| Image | Size |
|---|---|
| `passo:local` | 712 MB |
| `passo-rabbitmq:local` | 274 MB |

The application image carries `libxml2`, `xsltproc`, the official AdE schemas
and stylesheets, and a compiled native addon. Validating against the real XSD
offline is worth the megabytes — the alternative is a network dependency on
every submission.

## Database growth

Measured across 1,178 submissions and 2,062 audit rows:

| Table | Size | Per invoice |
|---|---|---|
| `sdi_submissions` | 4.5 MB | ~3.9 KB |
| `invoices` | 1.7 MB | ~1.5 KB |
| `audit_log` | 1.0 MB | ~0.9 KB |
| `correlation_records` | 0.7 MB | ~0.6 KB |
| `outbox` | 0.6 MB | ~0.5 KB |

**~7.4 KB per invoice while in flight**, dominated by the encrypted XML.

::: tip This does NOT grow for ten years
PASSO purges the payload once a terminal receipt arrives. What survives is the
correlation record — identifiers and status, ~0.6 KB — for
`CORRELATION_RETENTION_DAYS` (default 90), and the audit log for
`AUDIT_RETENTION_MONTHS` (default 12).

The ten-year archive is the **CRM's** obligation, not PASSO's. Sizing PASSO for
a decade of invoices means sizing it for something it does not keep.
:::

### Steady state

For **N invoices per day**:

```
in-flight     ≈ N × 7.4 KB × (days before a terminal receipt, usually < 2)
correlation   ≈ N × 0.6 KB × CORRELATION_RETENTION_DAYS
audit         ≈ N × 0.9 KB × 30 × AUDIT_RETENTION_MONTHS
```

At 10k invoices/day with the defaults: ~150 MB in flight, ~540 MB of
correlation records, ~3.2 GB of audit log — **under 4 GB steady state**, versus
roughly 27 GB/year if payloads were retained.

Attachments are the exception: they travel inside the invoice, capped at 20 MB
decoded, and are purged with it.

## Scaling

- **`api`** is stateless — run as many as you like behind a load balancer.
- **`worker`** scales horizontally; RabbitMQ distributes the queue.
- **`relay`** uses `SELECT … FOR UPDATE SKIP LOCKED`, so replicas partition the
  outbox rather than duplicating it.
- **`postgres`** is the single point of failure and the durability boundary.
  Back it up; RabbitMQ and Redis are reconstructible.

Migrations take a Postgres advisory lock, so simultaneous replica starts
serialise instead of racing.
