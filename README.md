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
(high+ must stay empty after Fastify 5.12.8 + protocol `v0.6.0` / Zod 4.6.7;
do not add IDs to `scripts/prod-audit-baseline.json`; new IDs fail). Tests
inject fetch doubles; CI does not enable live crawl, paid providers, or
model spend. Protocol pin is `v0.6.0` (Zod 4; v0.4 command/audit field names
stay valid). Do not npm-override Zod 4 onto protocol `v0.4.0`.

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

## Analytics-driven review (`review_performance` evaluator)

Closed-loop campaign analytics ingest still lives in audit; live provider
adapters are not in this process. This gateway now runs a **deterministic
evaluator** on `stepType: review_performance` (Context packet → gates →
audited `report` / `no_action` / `blocked` / dry-run proposal). It does
**not** call Ads, does **not** pay for an LLM turn, and **never grants
spend**. Dry-run proposals are evidence only, not Hub approval.

See [docs/ANALYTICS_EVALUATOR.md](docs/ANALYTICS_EVALUATOR.md) for gates,
Hub cadence/coalescing contract (Hub work later; not this PR), and t140
(page creation + gVisor limb builder deferred; URL origin is the operator
or a future page service with provenance — **no hardcoded host**).

## Owner action policies

Default for Ads verbs is Hub **approval**. An owner-published, versioned
document may set `deny` or `auto_with_limits` for a scoped verb. Auto skips
**Hub approval only** for pause / known cap-decrease after immutable
preflight; it still uses the Ads port, still fails closed when Ads is
unconfigured, and **never grants spend**. Delegation cannot be enabled.
Cross-provider budget movement is a separate catalogued, not-allowlisted
verb. Evaluator dry-run proposals are not execution authority.

Hub scheduling, coalescing, and proposal UX are a contract in
[docs/ACTION_POLICIES.md](docs/ACTION_POLICIES.md) — **not implemented in
Hub here**. This gateway has no public policy HTTP API in this slice;
production uses `ACTION_POLICY_STORE_DIR` / `ACTION_OUTCOME_STORE_DIR`
files (same single-replica caveat as the run store).

This gateway remains the **only** bounded command path for paid/mutating
work: Context packet → optional LLM turn → catalog verbs → Hub approval →
Ads domain. Audit stores events; it must not execute.

Preflight already matches the intended policy and must stay that way:

- Before **every** LLM turn: intent, workspace auth, run budget (never
  relaxed). `llm.quota` is unknown until proba-llm exposes `/v1/quota`;
  unknown is not a verified credit balance. The evaluator phase **omits**
  `llm.quota`.
- Before **Ads mutate**: Ads service/connection/permissions, blueprint when
  a `probaCampaignId` must exist, billing **only** for spend increase
  (create, resume, budget up). Analysis, report, and pause may relax **ad
  balance**, never auth or model caps.
- Targeting edits are not automatically safe. Owner **action policies**
  (`docs/ACTION_POLICIES.md`) default to Hub approval. `auto_with_limits`
  may skip Hub approval only for scoped pause/cap-decrease after immutable
  preflight; it still uses the Ads port (unconfigured fails closed) and
  **never grants spend**. Evaluator dry-run is not execution. Cross-provider
  budget moves are a separate denied verb. Hub scheduling/UX is documented,
  not implemented.
- Idempotency and ambiguous outcomes: no blind retry. Campaign decision
  version is the Context `asOf` stored per campaign in this process.

First slice stays: user-provided landing page URL + one provider. Page
generation and extra providers stay refused / not allowlisted.
