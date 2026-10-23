# Queue Topology

RabbitMQ is **transport**, not durability. Postgres is the durability boundary: an invoice and its job are written in one transaction, and the relay publishes from the outbox afterwards. Nothing that matters survives only in the broker.

That framing explains everything below. The broker's job is routing, delayed retry and dead-lettering — losing a message costs a redelivery, not an invoice.

## Exchanges

| Constant | Name | Type | Purpose |
|---|---|---|---|
| `invoices` | `passo.invoices` | `topic` | Primary work routing |
| `retry` | `passo.retry` | **`x-delayed-message`** | Backoff redelivery |
| `dlx` | `passo.dlx` | `topic` | Dead-letter routing |
| `webhooks` | `passo.webhooks` | `topic` | Declared; not used for routing in this build |

All durable. `passo.retry` is declared with `{ 'x-delayed-type': 'topic' }` and requires the delayed-message plugin.

Routing keys are `<tenantId>.<queue>` — for example `7a3f0c11-....q.submit-sdi`. Queues bind with `*.<queue>`, so the tenant segment is carried for observability rather than for routing.

## Queues

| Constant | Name | DLQ | Consumer |
|---|---|---|---|
| `transform` | `q.transform` | `dlq.transform` | **none** |
| `generate` | `q.generate-xml` | `dlq.generate-xml` | **none** |
| `sign` | `q.sign` | `dlq.sign` | **none** |
| `submit` | `q.submit-sdi` | `dlq.submit-sdi` | `startSubmitWorker` |
| `pecParse` | `q.pec-parse` | `dlq.pec-parse` | **none** |
| `notify` | `q.notification` | `dlq.notification` | **none** |
| `webhook` | `q.dispatch-webhook` | `dlq.dispatch-webhook` | `startWebhookWorker` |

Every queue is declared durable with `deadLetterExchange: passo.dlx` and a matching DLQ, and bound to both `passo.invoices` and `passo.retry`.

::: warning Five queues have no consumer in this build
Only `q.submit-sdi` and `q.dispatch-webhook` are consumed. The other five are declared, bound and dead-letter-configured — and nothing reads them.

That is not an oversight in the topology; it reflects where the work actually happens:

- **Transformation and XML generation are synchronous**, inside the API request. `submitInvoice` validates, generates and XSD-checks before returning `202`, so a caller learns about a schema failure immediately rather than by webhook minutes later.
- **Signing** is done by the channel (OpenAPI.it with `requestSigning` on). PASSO holds no qualified certificate, and a caller-supplied `.p7m` is not supported yet.
- **PEC parsing** happens inline in the poller, which parses attachments and calls `ingestNotification` directly.
- **Notification ingestion** likewise runs inline from the poller.

Their DLQs exist and will stay empty. `passo-cli dlq list` prints all seven names because it enumerates the `QUEUES` constant.
:::

DLQ names are derived mechanically:

```ts
export const dlqName = (q: QueueName): string => `dlq.${q.replace(/^q\./, '')}`;
```

---

## Retry is two unrelated mechanisms

Conflating these is the most common misreading of PASSO's retry behaviour, so they are kept separate here.

| | **Queue retry ladder** | **Submission retry guard** |
|---|---|---|
| Question | "This job failed — try again?" | "May this submission be re-sent to SdI?" |
| Scope | One RabbitMQ message | One submission's lifecycle |
| Implemented in | `topology.ts` `RETRY` + `backoffMs` | `state.ts` `canRetry()` |
| Triggered by | A worker throwing | `POST /retry`, MCP `retry_submission` |
| Outcome | Delayed redelivery, or DLQ | Proceed, or `409` with an explanation |

The first is infrastructure. The second is the thing standing between an automated retry loop and a duplicate document at the Italian tax authority.

---

## 1. The queue retry ladder

Per job type. **Never uniform** — a uniform policy is either too aggressive for the deterministic stages or too timid for the network-bound ones.

| Queue | Max attempts | Base | Cap | Rationale |
|---|---|---|---|---|
| `q.transform` | **1** | 0 | 0 | Deterministic. A failure is a data defect |
| `q.generate-xml` | **1** | 0 | 0 | Deterministic. Same input, same failure |
| `q.sign` | 3 | 2 s | 32 s | A signing service can blip |
| `q.submit-sdi` | 5 | 5 s | 5 min | Network + vendor. The most valuable retry |
| `q.pec-parse` | 3 | 5 s | 60 s | IMAP/mail-parsing transients |
| `q.notification` | 3 | 1 s | 30 s | Local DB work; short backoff |
| `q.dispatch-webhook` | **6** | 1 s | **1 h** | The receiver may be down for a while |

### Why the deterministic stages get exactly one attempt

`maxAttempts: 1` on `q.transform` and `q.generate-xml` is deliberate. These are pure functions of their input. Given the same invoice, a second run produces the same failure, and a third, and a fourth.

Retrying wastes capacity and — worse — buries the real signal. A `400`-class defect that appears once is a clear error report; the same defect appearing five times over two minutes looks like flapping infrastructure. Failing immediately to the DLQ says exactly what it is: this data cannot be processed, look at the data.

### Why webhooks get six attempts reaching an hour

The receiver is someone else's system, and it can be down for a deploy, a database migration or a bad afternoon. The ladder runs roughly 1 s → 2 s → 4 s → 8 s → 16 s → 32 s, capped at one hour — enough to ride out a genuine outage without giving up in ninety seconds.

::: tip Exhaustion is not loss
Once the ladder is exhausted the event is **not dropped**:

```ts
log.error({ eventId, eventType, attempts: attempt }, 'webhook exhausted — see GET /pending');
```

It remains visible in `GET /api/v1/pending` as an unacknowledged receipt. That endpoint is the safety net: if your endpoint was down and the ladder ran out, poll and reconcile. Nothing is silently lost.
:::

### Backoff and jitter

```ts
export function backoffMs(q: QueueName, attempt: number): number {
  const p = RETRY[q];
  const raw = Math.min(p.baseMs * 2 ** Math.max(0, attempt - 1), p.maxMs);
  return Math.round(raw * (0.75 + Math.random() * 0.5));   // jitter
}
```

Exponential from `baseMs`, capped at `maxMs`, multiplied by a random factor between **0.75 and 1.25**.

The jitter matters. Without it, a vendor outage that fails 200 submissions simultaneously produces 200 retries at exactly `t+5s`, then 200 at `t+15s` — a thundering herd that arrives precisely as the vendor is trying to recover, and that can keep it down. Spreading each wave over a ±25% window turns a spike into a trickle.

For `q.submit-sdi`, the ladder is roughly 5 s, 10 s, 20 s, 40 s, 80 s — each ±25%.

### Retryable vs terminal channel failures

The ladder only runs when the failure is transient. `ChannelError` carries the verdict:

```ts
const canRetry = err instanceof ChannelError ? err.retryable : true;
if (canRetry && attempt < RETRY[QUEUES.submit].maxAttempts) {
  broker.publish(EXCHANGES.retry, `${tenantId}.${QUEUES.submit}`,
    { ...msg, attempt }, { delayMs: backoffMs(QUEUES.submit, attempt) });
  return;
}
// otherwise: mark failed, audit, throw → DLQ
```

| Channel outcome | `retryable` | Behaviour |
|---|---|---|
| Unreachable / timeout | `true` | Ladder |
| HTTP 5xx | `true` | Ladder |
| HTTP 401 / 403 | **`false`** | Immediate DLQ |
| Other 4xx (`ERR_CHANNEL_REJECTED`) | **`false`** | Immediate DLQ |
| PEC over 30 MB | **`false`** | Rejected before queueing |

Bad credentials do not become good credentials by waiting. Retrying a `401` five times produces five failures and possibly a vendor-side lockout.

Note that an unknown non-`ChannelError` defaults to `retryable: true` — an unexpected exception gets the benefit of the doubt.

---

## 2. The submission retry guard

A separate question, asked by `POST /api/v1/invoices/{id}/retry` and by the MCP `retry_submission` tool:

```ts
export function canRetry(state: State): { ok: boolean; reason?: string } {
  if (state === STATE.rejected)         return { ok: false, reason: 'ERR_CONFLICT_NS_RETRY' };
  if (state === STATE.awaitingDelivery) return { ok: false, reason: 'ERR_CONFLICT_MC_RETRY' };
  if (TERMINAL.has(state))              return { ok: false, reason: 'ERR_CONFLICT_TERMINAL' };
  return { ok: true };
}
```

| Notification | State | Retryable | Why |
|---|---|---|---|
| **NS** | `rejected` | **never** | Terminal. The invoice is legally **not issued**. A corrected invoice needs a **new** `ProgressivoInvio`, which only a new submission gets |
| **MC** | `awaiting_delivery` | **never** | Not a failure. The invoice **is** issued; SdI is still delivering. Resubmitting duplicates it |
| **RC** | `delivered` | no | Success |
| **DT** | `delivered` | no | Terminal (PA silence) |
| **AT** | `undelivered_attested` | no | Terminal |
| **NE** `EC01` | `accepted_by_pa` | no | Terminal |
| **NE** `EC02` | `rejected_by_pa` | no | Terminal. A **commercial** dispute, not a schema failure |
| — | `failed` | no | Never reached SdI. Operator task via the DLQ |
| — | `queued` / `transmitting` | **yes** | Not yet terminal |

### NS never retries

An `NS` means SdI refused the file. The invoice does not exist for tax purposes. Retrying is not merely useless:

1. **The `ProgressivoInvio` is burned.** SdI has seen it; resubmitting yields another rejection, this time for duplication.
2. **The defect is unchanged.** Nothing about the invoice differs between attempts.
3. **A corrected invoice needs a fresh progressivo**, which only `POST /invoices` allocates.

Everything about an `NS` argues for automatic retry — it is a failure, from an external system, with a `/retry` endpoint next to it. That is exactly why the refusal is explicit and carries a full sentence of explanation rather than a bare `409`.

### MC is a wait, not a retry

::: danger There is no scheduled MC re-check
`MC` (`NotificaMancataConsegna`) means SdI accepted the invoice and could not yet deliver it. SdI keeps trying **on its own**, for days.

PASSO implements **no timer, no scheduled re-check and no polling job** for this. The submission sits in `awaiting_delivery` and waits for SdI's next notification, which arrives through the same ingress as any other.

The exact duration of SdI's delivery-retry window is **[UNVERIFIED]** — no timer for it exists in this codebase, and none is claimed. The same applies to the PA response window before a `DT`.
:::

Because `MC` reads like a failure — the name contains *mancata*, failed — a state machine grouping notifications into success and failure will put it in the wrong bucket, and the retry that follows submits a second copy of a document that already legally exists. Hence the explicit refusal, the state named `awaiting_delivery` rather than `failed`, and the webhook flags:

```json
{ "notificationType": "MC", "legallyIssued": true,
  "retryable": false, "action": "none_required" }
```

### NE is a PA decision

`NE` (`NotificaEsito`) is the public administration's accept/reject, not SdI's. `EC01` accepts; `EC02` rejects.

`EC02` is a **commercial** dispute — the invoice was validly issued and delivered; the PA is contesting its content. That is a business conversation, not a resubmission, and it is why `rejected_by_pa` is terminal.

---

## Dead-letter behaviour

A queue dead-letters when its handler throws and the retry ladder is exhausted or does not apply.

```ts
} catch (e) {
  log.error({ err: e, queue: q }, 'job failed');
  // requeue=false: routing to the DLX is what gives us a dead-letter
  // queue at all. Requeueing here would spin the message forever.
  ch.nack(msg, false, false);
}
```

::: warning `nack(msg, false, false)` — the second `false` is load-bearing
`requeue: true` puts the message back at the head of the **same** queue, where it is picked up immediately, fails identically, and is requeued again. That is an infinite hot loop at full CPU, with no backoff and no dead letter.

`requeue: false` routes it to the dead-letter exchange, which is the only reason a DLQ exists at all.
:::

`prefetch` is 4 per consumer — a worker holds at most four unacked messages, so a slow submission does not starve the others and a crash loses at most four in-flight jobs to redelivery.

### Inspecting a DLQ

```bash
docker compose exec rabbitmq rabbitmqctl list_queues name messages | grep dlq
```

Or the management UI on `RABBITMQ_MGMT_PORT` (default 15672).

`passo-cli dlq list` prints **queue names**, not contents — it enumerates the naming convention without connecting to count anything.

### Replay

```bash
passo dlq replay dlq.submit-sdi
```

Consumes each message, republishes it to `passo.invoices` with the routing key rewritten from `dlq.` to `q.` and `attempt` reset to `0`. It consumes for a fixed **2 seconds** and closes, so a large DLQ needs several passes.

::: danger Replay does not bypass the retry guard
The CLI's own comment says so:

```ts
// NOTE: an NS-rejected submission is refused downstream by the retry
// guard — replaying it would submit a duplicate to the tax authority.
```

A replayed message reaches the submit worker, which re-reads the submission's state:

```ts
if (s.state !== STATE.queued && s.state !== STATE.transmitting) {
  log.info({ submissionId, state: s.state }, 'submission no longer submittable');
  return;
}
```

An `NS`-rejected submission is in state `rejected`, so the job returns without transmitting. That check is what makes replay — and at-least-once delivery generally — safe.
:::

**Diagnose before replaying.** A message is in a DLQ because it failed after exhausting its retries. Replaying without fixing the cause reproduces the failure and puts it straight back. An `ERR_CHANNEL_AUTH` in the worker logs means credentials, and no amount of replaying fixes credentials.

---

## The delayed-message plugin is mandatory

```ts
await ch.assertExchange(EXCHANGES.retry, 'x-delayed-message', {
  durable: true, arguments: { 'x-delayed-type': 'topic' },
});
```

The **official RabbitMQ image does not bundle `rabbitmq_delayed_message_exchange`.** PASSO builds a custom image (`docker/rabbitmq/Dockerfile`) that bakes it in.

### What breaks without it

`x-delayed-message` is not a recognised exchange type, so the assert fails and the channel closes. If that were swallowed, every retry publish would carry an `x-delay` header nothing honours, and the broker would deliver **immediately**.

The 5 s → 10 s → 20 s → 40 s → 80 s ladder collapses into five immediate redeliveries — a hot loop against the Italian tax authority's infrastructure.

::: danger PASSO refuses to boot rather than pretend
```
PASSO_BOOT_REFUSED: rabbitmq_delayed_message_exchange plugin is NOT installed.
Without it, every retry becomes IMMEDIATE redelivery — a hot loop that would
hammer SdI with duplicate submissions. Build the broker from
docker/rabbitmq/Dockerfile, which bakes the plugin in. To run degraded anyway
(local development only), set PASSO_ALLOW_NO_DELAYED_EXCHANGE=1.
```

The connection is closed and the process exits.

This is deliberate. A hot loop presents as "our retries are far too aggressive", not as "a broker plugin is missing" — the retry configuration in the code is visibly correct, so nobody looks there. A crash-looping container with an explicit message is a far better outcome than a running system silently duplicating submissions to a tax authority.
:::

::: warning The degraded mode is for local development only
`PASSO_ALLOW_NO_DELAYED_EXCHANGE=1` downgrades the refusal to a warning and connects on a reduced topology: queues bind to `passo.invoices` and the DLX but **not** to `passo.retry`, and `publish` omits the `x-delay` header when the plugin is absent.

The system runs. It does not back off. Never set this where real invoices are transmitted.
:::

Verify:

```bash
docker compose exec rabbitmq rabbitmq-plugins list -e | grep delayed
# rabbitmq_delayed_message_exchange   3.13.0
```

Pin the plugin version to the broker's minor version.

---

## Message shape

```ts
export interface JobMessage {
  tenantId: string;
  submissionId?: string;
  attempt: number;
  payload: Record<string, unknown>;
}
```

Published `persistent: true` with `contentType: 'application/json'`.

`tenantId` travels with every message because the consumer sets the RLS context from it — the relay drains across tenants and cannot itself hold a tenant context. `attempt` is carried by the message rather than stored, so a redelivery knows where it is on the ladder.

---

## Operational signals

**Queue depth** — a persistently non-empty `q.submit-sdi` means the worker is down or the channel is failing:

```bash
docker compose exec rabbitmq rabbitmqctl list_queues name messages consumers
```

`consumers` should be at least 1 on `q.submit-sdi` and `q.dispatch-webhook`, and 0 on the other five (expected — they have no consumer).

**Outbox lag** — the earlier signal, because it catches a dead relay before the broker shows anything:

```sql
SELECT count(*) AS unpublished, min(created_at) AS oldest
  FROM outbox WHERE published_at IS NULL;
```

Should be near zero. A growing count with an old `oldest` means the relay process is not running.

**DLQ depth** — should be zero. Anything else needs diagnosis before replay.

**Ingress heartbeat** — the signal no queue can give you:

```sql
SELECT channel, poll_based, last_poll_at, last_error_at
  FROM channel_health ORDER BY channel;
```

::: warning The failure mode with no error
A submission that reaches SdI and never hears back throws nothing, retries nothing and grows no queue. It just waits.

Queue depth cannot detect it, because the work already left the queue. Outbox lag cannot detect it, because the row was published. If the PEC poller dies during a quiet hour, **every** signal on this page stays green while receipts silently stop arriving.

The stall detector (running in the `worker` role every 15 minutes) covers this by reading `channel_health.last_poll_at`. A poll cycle older than **30 minutes** means the ingress path itself has stopped — and that is detectable even when nothing is currently in flight, which is the whole point.

It separates that from "SdI is slow": a submission waiting past a channel threshold (**144 hours** for real channels, against SdI's own 5-day B2B delivery limit) is reported at lower severity and never as a poller failure. The distinguishing signal is breadth — many submissions stalling together on one channel with a stale poll cycle means ingress; one old submission on a healthy channel means SdI.
:::

::: tip Neither the worker nor the relay has a healthcheck
They expose no port. Their health is queue depth, outbox lag and `channel_health.last_poll_at` — those are what you should be alerting on, not a probe.
:::

## Related

- [How PASSO works](/guide/architecture) — the full lifecycle and why the outbox exists
- [Errors](/api/errors) — `ERR_CONFLICT_NS_RETRY` and `ERR_CONFLICT_MC_RETRY`
- [Deployment](/operations/deployment) — building the custom RabbitMQ image
- [Runbook](/operations/runbook) — what to do when a submission is stuck
