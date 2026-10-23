# Transformations

A declarative JSON mapping from your CRM's invoice shape to PASSO's canonical model. Rules are data, not code — there is no expression language, no scripting hook and no escape hatch, and that is a security property rather than a missing feature.

## Applying a template

Name the template in the submission. It is **never** selected implicitly — not
by tenant default, not by sniffing the payload shape — because an unrelated
template edit would then silently change how every future invoice is
interpreted, and you could not tell from your own request what was sent to the
tax authority.

```json
POST /api/v1/invoices
{
  "sellerId": "…",
  "transformation": "acme-crm",
  "invoice": { "doc_no": "2026/7", "items": [{ "cents": 100000 }] }
}
```

Omit `transformation` and the body is parsed as the canonical model directly —
see [Invoice data model](/api/invoice-model).

A mapping failure is a `400 ERR_TRANSFORM_FAILED` naming **both** paths:

```json
{ "error": { "code": "ERR_TRANSFORM_FAILED",
  "details": [{ "sourcePath": "doc_no", "targetPath": "number" }] } }
```

`targetPath` alone would be useless — you sent `doc_no`, not `number`.

## Test before you submit — `POST /api/v1/transformations/test`

::: danger Author here, not in production
An invoice submitted with a wrong mapping is **legally issued** the moment SdI
accepts it. There is no undo; correcting it means a credit note. The dry-run
endpoint exists so no mapping is ever tested against the real tax authority.
:::

It runs the same engine under the same limits, and **submits nothing, queues
nothing, persists nothing**. Pass either a saved `transformation` name or an
inline `template`, so a mapping can be iterated before it is ever saved.

```bash
curl -X POST $PASSO/api/v1/transformations/test \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{ "transformation": "acme-crm", "payload": { … your CRM shape … } }'
```

The response carries four things:

| Field | What it tells you |
|---|---|
| `output` | The canonical invoice your rules produced |
| `trace` | Per rule: source value → **each step** → final value |
| `errors` | **Every** rule failure at once, each with both paths |
| `canonicalValid` / `canonicalErrors` | Whether the output is actually submittable |

`errors` accumulates rather than stopping at the first failure — a ten-field
mistake is one round-trip, not ten.

The `trace` is what makes a wrong mapping self-diagnosing. This is the money
conversion, shown step by step:

```json
{ "target": "lines[0].unitPrice", "source": "items[0].cents",
  "sourceValue": 100000,
  "steps": [ { "fn": "divide", "arg": 100, "in": 100000, "out": "1000" },
             { "fn": "toDecimalString", "arg": 2, "in": "1000", "out": "1000.00" } ],
  "result": "1000.00" }
```

Swap `divide` for `multiply` and the result is `"10000000.00"` — a plausible
number, wrong by 10,000×, and only the step values reveal it.

## Managing templates

| | |
|---|---|
| `POST   /api/v1/admin/tenants/{id}/transformations` | Save. **Re-saving a name updates it** (`201` created, `200` updated) |
| `GET    /api/v1/admin/tenants/{id}/transformations` | List — names and rule counts, not rule bodies |
| `GET    /api/v1/admin/tenants/{id}/transformations/{name}` | Fetch one in full |
| `DELETE /api/v1/admin/tenants/{id}/transformations/{name}` | Remove |

Names are unique per tenant and are the addressing scheme at submission time.
Two tenants may both call their mapping `default`; one tenant may not.

## Why there is no `eval`

Start here, because it explains every other decision on the page.

A transformation template is authored by **whoever holds a tenant API key** — including anyone who stole one. It would execute on every invoice, inside a process that holds decrypted channel credentials, an open database pool and network access.

Any code-execution path in that position is remote code execution. Not "a sandbox escape risk" — RCE, directly, by design.

```
stolen API key → POST a template → arbitrary code in a process holding:
                                     · decrypted PEC/vendor credentials
                                     · a Postgres connection
                                     · outbound network access
```

So the engine has:

- No `eval`
- No `new Function`
- No `vm`, `vm2` or `isolated-vm`
- No template engine with expression support (Handlebars helpers, Liquid, JSONata, JMESPath — none)
- No user-supplied regex outside one guarded function

Only the whitelisted functions below, applied in a fixed order, to values read from fixed paths.

::: tip Sandboxes are not the answer here
`vm2` was retired after a series of unfixable escapes. `isolated-vm` is genuinely stronger, but it makes the security of a tax-document relay depend on the ongoing correctness of a V8 isolation boundary against attacker-supplied code.

A whitelist of 18 pure functions has a smaller attack surface than any sandbox, and its correctness is auditable by reading one file.
:::

## Template shape

```json
{
  "name": "acme-crm-v1",
  "sourceFormat": "acme-json",
  "rules": [
    { "target": "number", "source": "doc.reference", "required": true },
    { "target": "date",   "source": "doc.issued",
      "transform": [{ "fn": "dateFormat" }] },
    { "target": "currency", "literal": "EUR" },
    { "target": "seller.vatId.country", "literal": "IT" },
    { "target": "seller.vatId.code", "source": "company.vat",
      "transform": [{ "fn": "upper" }, { "fn": "trim" }] }
  ]
}
```

### Rule fields

| Field | Type | Notes |
|---|---|---|
| `target` | string | **Required.** Dotted path in the canonical model |
| `source` | string | Dotted path in your payload |
| `literal` | string \| number \| boolean | A constant. Takes precedence over `source` |
| `transform` | step[] | Functions applied left to right |
| `required` | boolean | Missing source raises instead of being skipped |

A step is `{ "fn": "name", "arg": value }`. `arg` is a single scalar; there are no multi-argument functions.

### Paths

Dotted, with `[]` marking an array segment:

```
doc.reference              → source.doc.reference
items[].amount             → each element of source.items
lines[].totalPrice         → each element of the target lines array
```

Reading a path through a missing intermediate returns `undefined` rather than throwing. A rule whose source resolves to `undefined` is **skipped** — unless `required: true`, or the chain contains `defaultTo`.

### Array rules

Rules whose target matches `prefix[].leaf` are grouped by prefix and applied per element:

```json
{
  "rules": [
    { "target": "lines[].lineNumber",  "source": "items[].position" },
    { "target": "lines[].description", "source": "items[].label" },
    { "target": "lines[].totalPrice",  "source": "items[].amount_cents",
      "transform": [{ "fn": "divide", "arg": 100 },
                    { "fn": "toDecimalString", "arg": 2 }] }
  ]
}
```

The source array comes from the first rule in the group. If it is not an array, the group is skipped silently — one of the few silent paths in the engine, and worth knowing when a `lines` array comes out empty.

## The complete whitelist

Eighteen functions. Anything not in this list is rejected **at save time**, with the full allowed set in the error message.

### String

| Function | `arg` | Behaviour |
|---|---|---|
| `trim` | — | Strips leading/trailing whitespace |
| `upper` | — | Uppercase |
| `lower` | — | Lowercase |
| `prefix` | string | Prepends |
| `suffix` | string | Appends |
| `concat` | string | Appends (alias of `suffix`) |
| `padStart` | number | Left-pads with `"0"` to the given width |
| `substring` | number | First *n* characters |

### Numeric — `Decimal`, never float

| Function | `arg` | Behaviour |
|---|---|---|
| `multiply` | number | Multiplies |
| `divide` | number | Divides. **Throws on zero** |
| `add` | number | Adds |
| `subtract` | number | Subtracts |
| `abs` | — | Absolute value |
| `round` | number | Fixed decimal places |

All six use `decimal.js`. No IEEE-754 arithmetic touches an amount at any point, so `0.1 + 0.2` is `0.3` here.

### Money

| Function | `arg` | Behaviour |
|---|---|---|
| `toDecimalString` | number (default 2) | Fixed-point string with mandatory decimals |

The mandatory terminal step on every monetary target — see below.

### Date

| Function | `arg` | Behaviour |
|---|---|---|
| `dateFormat` | — | Parses and emits `YYYY-MM-DD`. Throws on an unparseable value |

Output is `toISOString().slice(0, 10)`, so parsing is UTC-based. A datetime near midnight in a non-UTC zone can land on the adjacent day — normalise upstream if that matters for your invoice dates.

### Extraction

| Function | `arg` | Behaviour |
|---|---|---|
| `regexExtract` | pattern | Returns capture group 1, or the whole match, or `null` |
| `defaultTo` | any | Substitutes when the value is `undefined`, `null` or `""` |

`defaultTo` is the one function that makes a rule fire on an absent source. Without it, a missing non-required source means the rule is skipped entirely.

### Non-scalar inputs are an error, not a coercion

```ts
function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  throw new TransformError(
    `expected a scalar value, got ${Array.isArray(v) ? 'an array' : 'an object'} — ` +
    'check the source path in the mapping');
}
```

`String({})` is `"[object Object]"`. That string is a perfectly valid `Descrizione` as far as any type check is concerned, and it would flow into a tax document and reach SdI.

A CRM that sends `{ "amount": { "value": 100, "currency": "EUR" } }` where a scalar was expected has a mapping error, and it must surface as one — at the rule that caused it, not as a bizarre value in a rejected invoice three days later.

## Hard limits

| Limit | Value | Enforced |
|---|---|---|
| `maxRules` | 500 | Save time |
| `maxChainDepth` | 10 | Save time |
| `maxArrayItems` | 10,000 | Apply time |
| `regexTimeoutMs` | 100 | Apply time (detects, does not interrupt) |
| `maxTemplateBytes` | 262,144 (256 KB) | Save time |

**500 rules.** The canonical model has on the order of 40 fields. 500 is generous for legitimate mappings and low enough that no template becomes a CPU amplifier.

**Chain depth 10.** Ten sequential transforms on one value is already more than any real mapping needs, and the cap bounds per-field cost.

**10,000 array items.** Applied to the *source* array before iteration begins, so an enormous input array fails fast with a clear message instead of consuming the worker.

**256 KB template.** Checked on the serialised JSON before any rule is examined.

Exceeding any of them is a `TransformError` naming the limit and the actual value.

## ReDoS: the real defence is at save time

`regexExtract` is the only place a caller-supplied pattern is compiled, and it gets two protections.

**At save time — `assertSafeRegex`:**

```ts
export function assertSafeRegex(pattern: string): void {
  if (pattern.length > 200) throw new TransformError('regex too long');
  if (/(\([^)]*[+*][^)]*\)\s*[+*])|(\[[^\]]*\][+*]\s*[+*])/.test(pattern)) {
    throw new TransformError(`regex has nested quantifiers (ReDoS risk): ${pattern}`);
  }
}
```

This rejects the classic catastrophic-backtracking shapes — `(a+)+`, `[a-z]+*` — before the pattern is ever stored. It is a heuristic, not a proof, but it catches the constructions that appear in practice.

**At apply time — a 100 ms budget:**

```ts
const started = Date.now();
const m = new RegExp(pattern).exec(str(v));
if (Date.now() - started > LIMITS.regexTimeoutMs) {
  throw new TransformError('regexExtract exceeded its time budget');
}
```

::: warning The 100 ms budget detects, it does not interrupt
JavaScript regex execution is synchronous and not cancellable. The elapsed-time check runs **after** `exec` returns, so a genuinely catastrophic pattern still blocks the event loop for its full duration; the check reports it afterwards.

The load-bearing defence is `assertSafeRegex` at save time. The runtime budget is a detector that turns a slow pattern into an actionable error rather than a mystery.
:::

## Errors carry both paths

```ts
export class TransformError extends Error {
  readonly sourcePath: string | undefined;
  readonly targetPath: string | undefined;
}
```

Every error raised from a rule carries **both** the canonical target and the CRM's source path.

This is not redundancy. Consider the message a target-only error produces:

```
lines[2].nature: Natura is required when vatRate is 0
```

The person reading it is an integrator at the CRM. They have never seen the identifier `lines[2].nature` — their payload says `line_items[2].tax_code`. They now have to reverse-engineer the mapping to find out which of their fields is at fault.

With both paths:

```
required field missing at source path "line_items[2].tax_code" → target "lines[2].nature"
```

They can act on it immediately, in their own vocabulary.

`applyTemplate` propagates them through the array path too, adding the item index:

```
required field missing at "items[].amount_cents" (item 47)
```

## Money rules

Two validations run on any rule whose target looks monetary. `isMonetaryTarget` is a case-insensitive suffix match, after stripping a trailing `[]`:

```
unitPrice · totalPrice · taxableAmount · taxAmount · amount
```

So `lines[].totalPrice`, `summaries[].taxAmount` and `payment.amount` all qualify.

### 1. `toDecimalString` is mandatory and must be last

```json
{ "target": "lines[].totalPrice", "source": "items[].net",
  "transform": [{ "fn": "toDecimalString", "arg": 2 }] }
```

Omitting it, or putting it anywhere but last, is rejected at save time:

```
monetary target "lines[].totalPrice" must end with toDecimalString
```

**Why.** FatturaPA amounts are patterned strings — `Amount2DecimalType` is `[\-]?[0-9]{1,11}\.[0-9]{2}`. The decimal part is mandatory in the XML.

A `divide(100)` on `100000` yields the string `"1000"` from `Decimal.toString()`. That is a bare integer. Emitted into the document it produces `<PrezzoTotale>1000</PrezzoTotale>`, which is schema-invalid — a rejection at the XSD gate for a mapping that looks entirely reasonable.

`toDecimalString` uses `Decimal.toFixed(dp)`, which always pads: `1000.00`.

It must be **last** because any numeric step after it re-enters `Decimal.toString()` and drops the padding again. `[toDecimalString, multiply]` produces exactly the bare integer the rule exists to prevent.

### 2. The money-direction lint

```json
{ "target": "lines[].totalPrice", "source": "items[].amount_cents",
  "transform": [{ "fn": "multiply", "arg": 100 },
                { "fn": "toDecimalString", "arg": 2 }] }
```

Rejected at save time:

```
monetary target "lines[].totalPrice" uses multiply(100) — did you mean divide(100)?
A CRM sending integer cents needs divide.
```

**Why this specific check earns its place.** Very many CRMs store money in integer minor units — `100000` for €1000.00. Converting to a decimal string is division:

| Direction | Operation | `100000` becomes |
|---|---|---|
| Cents → decimal ✅ | `divide(100)` | `1000.00` |
| Decimal → cents ❌ | `multiply(100)` | `10000000.00` |

The inverted version is a **hundredfold overstatement** on a tax document. And it fails silently at every layer that could otherwise catch it:

- The value is a valid decimal string.
- It satisfies `Amount2DecimalType`.
- It passes the XSD.
- SdI accepts it — SdI validates format, not your commercial intent.
- It is delivered, and it is legally issued.

The first thing that notices is a customer receiving an invoice for €10,000,000.00, or an accountant during a reconciliation weeks later. By then the invoice is legally issued and the remedy is a credit note.

There is no context in which a monetary *target* legitimately needs `multiply(100)`. Multiplying by 100 converts *to* cents, and the target is a decimal-string field. So the engine treats it as a probable inversion and refuses to store the template.

::: tip If you genuinely need a ×100 factor
Use `multiply(10000)` then `divide(100)`, or restructure the chain so the literal `100` is not a multiplier on a monetary target. The lint is deliberately narrow — it fires only on `multiply` with the argument exactly `100` on a monetary target — so unit conversions with other factors are unaffected.
:::

## Worked example

A CRM sending cents, a prefixed VAT number and ISO timestamps:

```json
{
  "name": "acme-crm-v1",
  "sourceFormat": "acme-json",
  "rules": [
    { "target": "documentType", "literal": "TD01" },
    { "target": "format", "literal": "FPR12" },
    { "target": "currency", "literal": "EUR" },

    { "target": "number", "source": "invoice.ref", "required": true },
    { "target": "date", "source": "invoice.issued_at",
      "transform": [{ "fn": "dateFormat" }] },

    { "target": "recipientCode", "source": "customer.sdi_code",
      "transform": [{ "fn": "upper" },
                    { "fn": "defaultTo", "arg": "0000000" }] },

    { "target": "seller.vatId.country", "literal": "IT" },
    { "target": "seller.vatId.code", "source": "company.vat_number",
      "transform": [{ "fn": "upper" },
                    { "fn": "regexExtract", "arg": "^IT([0-9]+)$" }] },
    { "target": "seller.taxRegime", "literal": "RF01" },

    { "target": "lines[].lineNumber",  "source": "items[].position", "required": true },
    { "target": "lines[].description", "source": "items[].label",
      "transform": [{ "fn": "trim" }, { "fn": "substring", "arg": 1000 }] },
    { "target": "lines[].quantity", "source": "items[].qty",
      "transform": [{ "fn": "toDecimalString", "arg": 2 }] },
    { "target": "lines[].unitPrice", "source": "items[].unit_cents",
      "transform": [{ "fn": "divide", "arg": 100 },
                    { "fn": "toDecimalString", "arg": 2 }] },
    { "target": "lines[].totalPrice", "source": "items[].total_cents",
      "transform": [{ "fn": "divide", "arg": 100 },
                    { "fn": "toDecimalString", "arg": 2 }] },
    { "target": "lines[].vatRate", "source": "items[].vat_bp",
      "transform": [{ "fn": "divide", "arg": 100 },
                    { "fn": "toDecimalString", "arg": 2 }] }
  ]
}
```

Three details worth noting:

- **`regexExtract "^IT([0-9]+)$"`** strips the country prefix. `IdPaese` and `IdCodice` are separate FatturaPA elements, and leaving `IT` inside `code` produces `ITIT01234567890`.
- **`vat_bp` → `divide(100)`.** Basis points to a decimal percent: `2200` → `22.00`. `AliquotaIVA` is a percent, not a fraction.
- **`defaultTo "0000000"`** on the recipient code. Note that this code additionally requires `recipientPec`, so the template needs a rule for that too.

## Registering a template

```bash
curl -X POST localhost:3000/api/v1/admin/tenants/$TENANT/transformations \
  -H "authorization: Bearer $ADMIN" \
  -H 'content-type: application/json' \
  -d @acme-crm-v1.json
```

```json
{ "id": "e5d8..." }
```

`201` means the template passed every save-time check: the whitelist, both rule limits, the regex safety heuristic and both money rules. A `TransformError` message names the offending rule's `target` and `source`.

There is no list, update or delete endpoint. `POST`-ing again creates a new row.

## Testing rules

The engine is a pure function of `(template, source)` and is exercised directly by the unit tests:

```ts
import { validateTemplate, applyTemplate } from './src/domain/transform/engine.ts';

const tpl = validateTemplate(JSON.parse(readFileSync('acme-crm-v1.json', 'utf8')));
const out = applyTemplate(tpl, sampleCrmPayload);
console.log(JSON.stringify(out, null, 2));
```

Run `npm test` to see the existing cases in `tests/unit/transform.test.ts`.
