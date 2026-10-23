# Contributing to PASSO

Thanks for wanting to help. PASSO handles tax documents: a wrong retry, a skipped XSD gate, or a leaked secret is not a cosmetic bug.

## Before you start

1. Read [What PASSO is not](docs/guide/scope.md). Do not add wording that calls PASSO an accredited intermediary, a *conservazione* provider, or certified.
2. Read [Three rules](README.md#three-rules-that-catch-most-integrations): NS is terminal, MC is not a failure, money is a string.
3. Do not commit `.env`, tokens, PEC passwords, or real invoice payloads. `.env.example` is the only env file in git.

## Setup

```bash
cp .env.example .env          # replace every CHANGE_ME
npm install
docker compose up -d postgres rabbitmq redis
docker compose run --rm migrate
npm test
```

Node 22+. Tests need the real stack (Postgres 16, Redis 7, RabbitMQ with `rabbitmq_delayed_message_exchange`). The custom image is `docker/rabbitmq`.

## What a change must pass

```bash
npm run typecheck
npm run lint                  # --max-warnings 0
npm test
npm run test:coverage         # gates in vitest.config.ts
npm run lint:docs             # legal-accuracy phrases, not style
npm run check:openapi         # after any Zod / route-contract change: npm run gen:openapi
npm run docs:build            # dead internal links fail the build
```

CI runs all of the above, plus gitleaks on full history, `npm audit --audit-level=high`, image build, Trivy, and a Compose smoke test.

## Pull requests

- Keep the diff tight. One concern per PR.
- Match the voice of the surrounding code: short, no ceremony, comments only for non-obvious invariants.
- If you change a Zod schema or an HTTP contract, regenerate OpenAPI (`npm run gen:openapi`) and update the narrative pages under `docs/api/`.
- If you add an environment variable, add it to `.env.example` and `docs/reference/configuration.md`.
- Do not weaken coverage gates, skip the XSD gate, or auto-retry NS / MC.
- Do not add a web UI. PASSO is API-only on purpose.

Use the [pull request template](.github/PULL_REQUEST_TEMPLATE.md).

## Reporting issues

- Bugs and features: [GitHub Issues](https://github.com/radioBros/passo/issues).
- Vulnerabilities: [SECURITY.md](SECURITY.md) — not a public issue.

## Licence

Contributions are accepted under [AGPL-3.0-or-later](LICENSE), the same licence as the project.
