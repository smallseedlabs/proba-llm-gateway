# proba-llm-gateway

Internal brain gateway. Hub calls **this** process; this process calls
**proba-llm** (`POST /v1/complete`) for one model turn. The harness (bounded
loop) lives inside this service: context enrichment, policy, Hub-bound
approvals, domain dispatch, and progress/final snapshots. The LLM never
executes tools. Hub owns user-facing approvals, pause, and emergency stop.

There is no DeepSeek (or other vendor) key here. That stays in proba-llm.
Unconfigured Ads (`ADS_DOMAIN_URL` empty) fail closed. Reddit / Microsoft /
Google / Meta provider adapters are **not** in this process.

## Local review

```bash
cd /Users/sangamdubey/Projects/proba/proba-llm-gateway
npm install
npm run typecheck
npm run lint
npm test
npm run build
npm run check:compose
npm run audit:prod
```

CI (GitHub Actions on `main` and `cursor/**`): lint, typecheck, tests with required
research-guard names, `tsc` build, Docker image build, compose loopback /
`RESEARCH_HTTP_FETCH=false`, gitleaks, CodeQL, and production `npm audit`
(high+; fastify 4 / zod 3 findings are a documented baseline until a dedicated
major upgrade — new IDs fail). Tests inject fetch doubles; CI does not enable
live crawl, paid providers, or model spend. Protocol stays on the existing
`v0.4.0` pin unless a later change needs 0.6.0.

Configure via `.env.example`. Secrets belong in `*_FILE` mounts, not source.
Test doubles are test-only (`NODE_ENV=test`).

Dockerfile is `Dockerfile`. Swarm stack is `deploy/stack.yml`: overlay-only
(`http://gateway:3700` on `proba-network`), no published port. LLM is
`http://llm:3600`. Replicas must stay **1** on a node labeled `proba.gateway=true`.
A second replica or reschedule onto another node does not see the local run
outbox. `AUDIT_PUBLISHER=log` is not a durable production audit. This repo
does not prove Redis/consumer durability.

Local compose publishes `127.0.0.1:3700` only. Do not treat that as public ingress.
This tree is for review; it is not deployed by the agent.

## Ads domain

Campaign verbs are Proba-domain operations (`probaCampaignId`). This gateway
POSTs `ADS_DOMAIN_URL/v1/campaign-actions` with a short-lived EdDSA token
(`aud=proba-ads`). Provider resource ids are mapped by that domain service,
not invented here. If `ADS_DOMAIN_URL` is unset, ads verbs throw rather than
fabricating success.

## Analytics-driven review (planned; evaluator not executor)

Closed-loop campaign analytics is specified in
[proba-audit architecture — closed loop](../proba-audit/docs/ARCHITECTURE.md)
(metrics ingest already exists; live adapters and the evaluator do not).

This gateway remains the **only** bounded command path: Context packet →
optional LLM turn → catalog verbs → Hub approval → Ads domain. An analytics
bot may **propose** `review_performance` / pause / cap / targeting edits; it
must not call Ads or the provider. Audit stores events and projections; it
must not execute.

Preflight already matches the intended policy and must stay that way:

- Before **every** LLM turn: intent, workspace auth, run budget (never
  relaxed). `llm.quota` is unknown until proba-llm exposes `/v1/quota`;
  unknown is not a verified credit balance.
- Before **Ads mutate**: Ads service/connection/permissions, blueprint when
  a `probaCampaignId` must exist, billing **only** for spend increase
  (create, resume, budget up). Analysis, report, and pause may relax **ad
  balance**, never auth or model caps.
- Targeting edits are not automatically safe. Stop/cap **safety** should be
  a deterministic verb path that does not require a paid model.
- Idempotency and ambiguous outcomes: no blind retry. Stale competing
  decisions are a campaign-version check in the Ads domain (planned), not a
  second loop here.

First slice stays: user-provided landing page URL + one provider. Page
generation and extra providers stay refused / not allowlisted.
