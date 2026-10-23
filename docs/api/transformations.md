# Transformations API

Map your CRM's invoice JSON onto PASSO's [canonical model](/api/invoice-model) without changing the CRM.

A transformation is **never applied implicitly**. `POST /invoices` uses one only when the body names it (`"transformation": "acme-v1"`). A default-by-tenant or a sniffed payload would mean an unrelated template edit silently changes what is sent to the tax authority.

The rule language, limits and function whitelist are in [Transformations](/integrations/transformations). This page is the HTTP surface.

## `POST /api/v1/transformations/test`

Dry-run. Submits nothing, queues nothing, persists nothing. Same engine, same limits, every error at once — plus a check of the output against `InvoiceSchema`.

Scope: `invoices:write`.

Either a saved name or an inline template:

```bash
curl -X POST localhost:3000/api/v1/transformations/test \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{
    "transformation": "acme-v1",
    "payload": { "doc": { "reference": "2026/0042" }, "items": [] }
  }'
```

```bash
curl -X POST localhost:3000/api/v1/transformations/test \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{
    "template": {
      "name": "draft",
      "rules": [
        { "target": "number", "source": "doc.reference", "required": true }
      ]
    },
    "payload": { "doc": { "reference": "2026/0042" } }
  }'
```

```json
{
  "transformation": "acme-v1",
  "output": { "number": "2026/0042" },
  "trace": [{ "target": "number", "source": "doc.reference", "ok": true }],
  "errors": [],
  "canonicalValid": false,
  "canonicalErrors": [{ "path": "documentType", "message": "Required" }],
  "submitted": false,
  "requestId": "…"
}
```

`submitted` is always `false`. Iterate until `canonicalValid` is `true`, then save the template (Admin API) and name it on `POST /invoices`.

`400` if `payload` is missing, or if neither `transformation` nor `template` is supplied. A named template that does not exist is `404`.

## Starter templates

Read-only teaching examples, identical for every tenant, stored in code. They are **not** mappings for a named CRM — a wrong starter looks authoritative and produces a plausible invoice with the wrong values.

### `GET /api/v1/starter-templates`

Scope: `invoices:read`.

```json
{
  "data": [
    { "key": "passthrough", "name": "…", "description": "…", "suits": "…", "rules": 12 },
    { "key": "generic-cents", "name": "…", "description": "…", "suits": "…", "rules": 14 },
    { "key": "generic-decimal", "name": "…", "description": "…", "suits": "…", "rules": 14 }
  ],
  "note": "No template for a named third-party CRM ships here. …",
  "requestId": "…"
}
```

### `GET /api/v1/starter-templates/{key}`

The full template (`rules` included). `404` for an unknown key.

### `POST /api/v1/transformations/from-starter/{key}`

Deep-copies the starter into **this tenant's** transformations. Edits stay on the copy.

Scope: `transformations:write`.

```bash
curl -X POST localhost:3000/api/v1/transformations/from-starter/generic-cents \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"name": "acme-cents"}'
```

```json
{
  "id": "…",
  "name": "acme-cents",
  "clonedFrom": "generic-cents",
  "rules": 14,
  "note": "A copy. Edit it freely — the starter is unchanged.",
  "requestId": "…"
}
```

`201` on first clone, `200` if the name already existed (the copy is replaced). `name` defaults to the starter key.

## Saving and listing templates

Create, list, fetch and delete saved templates through the [Admin API](/api/admin#transformations):

| Method | Path |
|---|---|
| POST | `/api/v1/admin/tenants/{id}/transformations` |
| GET | `/api/v1/admin/tenants/{id}/transformations` |
| GET | `/api/v1/admin/tenants/{id}/transformations/{name}` |
| DELETE | `/api/v1/admin/tenants/{id}/transformations/{name}` |

`POST` upserts on `(tenant_id, name)` and validates the template at save time (function whitelist, rule limits, regex safety, monetary-target rules). An invalid template is refused now, not on the first invoice.
