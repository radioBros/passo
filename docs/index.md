---
layout: home
hero:
  name: PASSO
  text: Italian e-invoicing relay
  image:
    src: /logo.png
    alt: PASSO
  tagline: Take an invoice from any CRM, produce valid FatturaPA XML, transmit it to SdI, and return the receipts.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What PASSO is not
      link: /guide/scope
features:
  - title: Self-hosted, open source
    details: One Docker stack. Your data stays on your infrastructure.
  - title: Pluggable SdI channels
    details: PEC or OpenAPI.it, plus a mock for development. Switch by configuration, not code.
  - title: A relay, not an archive
    details: Payloads are purged once a terminal receipt arrives. Your CRM remains the system of record.
