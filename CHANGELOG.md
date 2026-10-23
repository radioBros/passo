# Changelog

## 1.0.0 — 2026-10-23

First public release.

- FatturaPA generation (FPR12 / FPA12) with a mandatory AdE XSD gate
- Channels: PEC (B2B), OpenAPI.it (B2B and B2G with vendor signing), mock
- Multi-tenant isolation via Postgres RLS
- Transactional outbox, delayed-message retry ladder, DLQ
- HMAC-signed webhooks, `GET /pending` reconciliation
- Transformations, starter templates, official AdE rendering
- Operator CLI, alerts, MCP server, purge and privacy export
- VitePress documentation and generated OpenAPI 3.0 contract
