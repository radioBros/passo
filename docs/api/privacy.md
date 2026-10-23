# Privacy and export

PASSO is a relay, not an archive. That changes both of these endpoints from their usual shape: there is almost never a 10-year store to export or erase. The CRM holds that.

## `GET /api/v1/invoices/{id}/export`

Everything PASSO still holds for one submission, in one call, hash-verifiable.

Take this **before** the terminal receipt. Afterwards the payload is purged and this returns `410 Gone` — there is no recovery path, and that absence is what keeps PASSO outside the *conservazione* obligation.

Scope: `invoices:read`.

```json
{
  "submissionId": "…",
  "invoice": {
    "number": "2026/0042", "documentType": "TD01",
    "issueDate": "2026-09-01", "progressivoInvio": "0002P",
    "fileName": "IT01234567890_0002P.xml", "signed": false
  },
  "transmission": {
    "channel": "openapi", "state": "transmitted",
    "identificativoSdI": "12345",
    "submittedAt": "…", "terminalAt": null, "createdAt": "…"
  },
  "xml": "<?xml version=\"1.0\"?><p:FatturaElettronica …>",
  "hashes": {
    "xmlSha256": "…",
    "recordedSha256": "…",
    "algorithm": "sha256",
    "note": "Computed over the plaintext XML bytes, not the stored ciphertext."
  },
  "rendered": "<html>…</html>",
  "notifications": [],
  "exportedAt": "2026-09-01T10:00:00.000Z",
  "requestId": "…"
}
```

`hashes.xmlSha256` is computed over the decrypted XML. Compare it to the file you store; you do not need PASSO's encryption keys. A rendering failure still returns the XML — that is the part with legal weight. `rendered` is then `null`.

`404` if the id is unknown (or belongs to another tenant — indistinguishable). `410` if purged.

The call is audited as `submission.export`.

## `POST /api/v1/privacy/erasure`

A data-subject enquiry. It **reports** what PASSO holds; it does not delete an in-flight transmission.

Scope: `invoices:read`. Supply at least one of `vatId`, `taxCode`, `subjectRef`.

```bash
curl -X POST localhost:3000/api/v1/privacy/erasure \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"vatId":"01234567890"}'
```

```json
{
  "subject": { "vatId": "01234567890", "taxCode": null, "subjectRef": null },
  "holds": {
    "archive": false,
    "inFlightDocuments": 0,
    "unacknowledgedReceipts": 0,
    "auditEntries": "operational forensics only, expires on its own schedule"
  },
  "erasable": true,
  "controller": "The CRM is the controller of the invoice archive. …",
  "auditLog": {
    "erasable": false,
    "reason": "The audit log is hash-chained …"
  },
  "requestId": "…"
}
```

If anything is mid-exchange with SdI, `erasable` is `false` and `refusal` lists those submissions. The refusal is about the **live transmission** — deleting PASSO's copy would orphan the receipt without recalling anything from the tax authority. It is not a retention-duty refusal: PASSO holds no archive.

The audit log is never erasable on request. It carries actors and actions, not invoice content, and expires on `AUDIT_RETENTION_MONTHS`.

See [Data protection](/compliance/data-protection) and [What PASSO is not](/guide/scope).
