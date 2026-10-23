# What PASSO Is Not

Read this before integrating. These boundaries are architectural, not disclaimers.

## Not an accredited SdI intermediary

PASSO transmits **through** an accredited channel — your PEC provider, or a vendor such as Invoicetronic or OpenAPI.it. It holds no accreditation of its own with Agenzia delle Entrate, and must never be described as if it did.

## Not a *conservazione a norma* provider

*Conservazione* is a regulated process requiring a designated *Responsabile della conservazione*, a *manuale della conservazione*, and qualified time-stamping.

**PASSO does not perform it and cannot.** It keeps no invoice archive: the payload and generated XML are purged once a terminal receipt arrives. What survives is a correlation record holding identifiers and status — no buyer or seller identity, no amounts, no XML.

The obligation belongs to the taxpayer. PASSO does not advise on how to discharge it.

## Not the system of record

**Your CRM is.** PASSO holds an invoice only while it is in flight. Fetch what you need before it is purged:

| Endpoint | Returns |
|---|---|
| `GET /invoices/{id}/xml` | The generated XML (or `.p7m` if signed) |
| `GET /invoices/{id}/receipts` | Every SdI notification |
| `GET /invoices/{id}/rendered` | Human-readable HTML via the official AdE stylesheet |

After purge these return **410 Gone**, not 404 — the submission existed; its payload is simply no longer held.

## Not certified

PASSO is software. It carries no SOC 2 report, no ISO certification, and no tax-authority approval. SOC 2 audits an organisation's service delivery, so only *you*, as the operator, can hold one for your deployment. PASSO ships the controls that make that audit passable.

## Not tax advice

Nothing PASSO returns — including a validation error or a rejection code — is advice on your tax obligations. Consult a *commercialista*.
