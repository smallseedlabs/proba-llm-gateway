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
```

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
