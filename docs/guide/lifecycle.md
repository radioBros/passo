# Submission lifecycle

Every state a submission can reach, what it means, and what you should do. The
two that get misread are `rejected` and `awaiting_delivery` — one looks
retryable and is terminal, the other looks like a failure while the invoice is
already legally issued.

## The states

| State | Trigger | Terminal | Legally issued | What to do |
|---|---|---|---|---|
| `queued` | Accepted by PASSO | no | no | Wait |
| `transmitting` | Being handed to the channel | no | no | Wait |
| `transmitted` | Reached SdI (**AT**) | no | no | Await the receipt |
| `delivered` | **RC** or **DT** | **yes** | **yes** | Nothing |
| `awaiting_delivery` | **MC** | no | **yes** | **Nothing.** See below |
| `undelivered_attested` | **AT** after SdI gave up | **yes** | **yes** | Give the invoice to the recipient yourself |
| `accepted_by_pa` | **NE** / `EC01` | **yes** | **yes** | Nothing |
| `rejected_by_pa` | **NE** / `EC02` | **yes** | **yes** | Resolve commercially — see below |
| `rejected` | **NS** | **yes** | **no** | **Issue a NEW invoice** |
| `failed` | Never reached SdI | **yes** | no | Fix and resubmit |

`GET /api/v1/invoices/{id}` returns `nextAction`, `terminal`, `legallyIssued`
and `guidance` alongside the state, so you do not have to encode this table.

## `awaiting_delivery` (MC) is not a failure

::: warning Do not resubmit on MC
*Mancata Consegna* means SdI **accepted** your invoice and could not deliver it
to the recipient yet. The invoice **is legally issued** — your tax obligation is
discharged at that moment, not at delivery.

SdI keeps trying on its own, for days. Resubmitting creates a **duplicate** at
the tax authority, which is rejected as `00409` and leaves you with two
documents to explain.
:::

The payload carries `legallyIssued: true` and `action: "none_required"` for
exactly this reason. If MC persists, SdI eventually issues an **AT** and the
state becomes `undelivered_attested` — at which point the invoice is still
issued, and you make it available to the recipient by other means.

## `rejected` (NS) is terminal

*Notifica di Scarto* means the invoice was **not** issued. Not "failed to
send" — not issued at all, as if it had never existed.

- `/retry` **refuses** with a `409`. This is deliberate.
- Fix the errors, then submit a **new** invoice. A fresh `ProgressivoInvio` is
  allocated automatically; never reuse the rejected one.
- The rejection reasons arrive enriched with a description and a remedy — see
  [Errors](/api/errors).

## `rejected_by_pa` (NE / EC02) still means issued

A public administration rejecting an invoice is a **commercial** rejection, not
a fiscal one. The invoice was validly issued through SdI; the PA is declining to
pay it as presented. Resolve it with the recipient — do not resubmit the same
document to SdI.

## What sync mode waits for

`mode: "sync"` resolves at **`transmitted`** and nowhere else. It never waits
for RC, MC or DT: MC delivery retry runs for days, so no HTTP timeout can
represent final delivery. On timeout you receive a `202` and the job continues
untouched.
