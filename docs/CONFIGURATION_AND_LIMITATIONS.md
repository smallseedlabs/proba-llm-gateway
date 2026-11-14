# Proba configuration, limitations, and realistic cost planning

Engineering inventory for operators and implementers. **Not** a product spec rewrite and **not** a silent activation of any budget.

- **As of:** 2026-11-08
- **Scope of this file:** tracked configuration and code on local sibling checkouts under `/Users/sangamdubey/Projects/proba`. Gitignored `.env` files were **not** read. Secret values, tokens, passwords, and private URLs are **not** recorded; names and safe defaults only (`SET` / `UNSET` where a live value might exist).
- **How to read:** **CURRENT VERIFIED** is what the code and tracked examples do today. **PROPOSED** is planning only and is **not** loaded by any service.

## 1. Method and coverage

| Included (tracked) | Not claimed |
| --- | --- |
| `proba-llm-gateway` `src/config.ts`, `.env.example`, `docker-compose.yml`, `deploy/stack.yml` | Any gitignored `.env` / `.env.local` |
| `proba-llm` `src/config.ts`, `.env.example`, `deploy/stack.yml` | `wt/` worktrees (duplicates of siblings) |
| `proba-hub` `src/config.ts`, `.env.example` | Exhaustive OpenAPI / SQL column catalogs |
| `proba-context` `docs/CONFIG.md`, `config/context.config.yaml`, `apps/context-api/src/runtime.ts` | Memory `job_configs` rows (runtime data, not env) |
| `proba-audit` `.env.example` | Live Swarm node labels / replica counts on a cluster |
| `proba-memory` `.env.example` | Vendor account balances or ad-platform minimums |
| `proba-web` `.env.example` | Protocol package runtime env (none) |
| `proba/local/.env.example` (platform compose) | Every ClickHouse grant statement |
| `proba-portal/.env.example` (browser/portal only) | |

Restart: Node services load env at process start unless noted (Context YAML can `SIGHUP` reload; `cacheStore.backend` cannot). Compose/Swarm changes need recreate.

## 2. `$2` is not a configured default

| Claim | Evidence |
| --- | --- |
| No `$2` model-cost default | `GATEWAY_MAX_COST_USD` is optional; code default is `null` (`proba-llm-gateway/src/config.ts` `envOptionalNumber`, lines 39–44 and 181). `.env.example` leaves it commented empty. Swarm/compose stacks do **not** set it. |
| Test fixtures use `$1`, not `$2` | Coordinator/smoke/reservation tests pass `maxCostUsd: 1` or `0.001` as **explicit** caps. |
| Nearby `$1000` / `$10000` are **ad-proposal** Hub-brain limits, not model token cost | `BRAIN_MAX_ACTION_SPEND` default `1000`, `BRAIN_MAX_PLAN_BUDGET` default `10000` USD in `proba-hub/src/config.ts` (lines 175–178). They apply to the Hub mock/DeepSeek brain **proposal** path, not gateway `run.budget`. |
| Do not activate `$2` (or any) global run ceiling | This document does **not** recommend shipping a default monetary cap. |

## 3. CURRENT VERIFIED — money, quota, and paid path

Three **distinct** claims. Do not mix them.

| Claim | Owner | Default | Failure / unknown |
| --- | --- | --- | --- |
| Model token / iteration / tool caps | gateway `run.budget` | Iterations `8`, LLM calls `8`, tool calls `16`, response reserve `512` tokens. `GATEWAY_MAX_TOTAL_TOKENS` / prompt / completion **unset** (`null`). | Hard stop (`BudgetExhaustedError` / `insufficient`). Never relaxed by LLM text. |
| Model **USD** ceiling | gateway `GATEWAY_MAX_COST_USD` | **UNSET** (`null`). Not `$2`. | If **explicitly set**: next `POST /v1/complete` runs only when a conservative bound (authoritative proba-llm unit prices × this-call token caps) **fits remaining room**. Unknown unit prices, unbounded prompt tokens, or prior unknown spend → `run.budget` `unknown` (blocked, **zero** paid dispatch). Bound larger than remaining → `insufficient`. **No first-call grace.** Unset cap: unknown cost stays explicit; token/run caps still apply. |
| LLM service quota / credits | optional `GET /v1/quota` | Endpoint **absent** (404 → `unknown`). `LLM_QUOTA_UNKNOWN_POLICY=allow_with_run_budget`. | `refuse` blocks paid calls. 5xx/unreachable → `llm.service` `unavailable`. `/ready` is **not** a credit. |
| proba-llm numeric cost on a turn | `PRICE_*` in **proba-llm** | **UNSET** → `cost.estimate=unknown` (`proba-llm/.env.example` lines 32–35; `src/config.ts` 144–148; `src/handler/single-turn.ts` `costOf`). | Unknown is never `$0`. Gateway does not invent rates. |
| Ad billing | Ads domain (not this process) | `ADS_DOMAIN_URL` empty → ads verbs fail closed. Unknown balance refuses **mutating** spend-increase. | Analysis / report / pause may relax **ad balance only**. |
| Hub gateway paid path | Hub `GATEWAY_URL` / `GATEWAY_ENABLED` | **UNSET / disabled**. Mock brain default. Combining with `BRAIN_PROVIDER=deepseek` refuses to start. | Enabled-but-down is fail-closed; no silent local-model fallback. Opt-in can call a live LLM. |

Conservative next-call bound (when a USD cap **is** set), implemented in `src/usage/reservations.ts`:

1. Observed spend: `0` if `llmCalls === 0`; numeric sum if every counted turn had the same `pricingVersion`; else **unknown remaining**.
2. Unit prices: `LlmClient.pricing()` (`GET /v1/pricing`). 404 / missing function / non-positive rates → **unknown** (not `$0`).
3. Token envelope: completion = same cap the loop sends as `maxTokens` (`responseTokenReserve` default 512, or remaining `GATEWAY_MAX_COMPLETION_TOKENS`). Prompt = remaining `GATEWAY_MAX_PROMPT_TOKENS` or remaining `GATEWAY_MAX_TOTAL_TOKENS`. If both prompt/total are unset, prompt is **unbounded** → cannot evaluate a USD cap.
4. Bound USD = `(promptMax × promptUsdPerMillion + completionMax × completionUsdPerMillion) / 1e6`. Dispatch iff `spent + bound ≤ cap`.
5. Same-run completes are serialized (`LoopCoordinator.serialize`). Ad spend is not subtracted here.

Default product UX is **not** blanket denial: with `GATEWAY_MAX_COST_USD` unset, paid calls still run under token/iteration caps. Setting the USD cap **without** `PRICE_*` (and a prompt/total token cap) is an explicit operator choice that blocks dispatch until those bounds exist.

## 4. CURRENT VERIFIED — gateway (`proba-llm-gateway`)

Process: Node 20, Fastify 5, port **3700**. Restart required for env. Production refuses vendor LLM keys in this process (`DEEPSEEK_API_KEY` / `LLM_API_KEY`). `INGRESS_PUBLIC=true` refused. GitHub Actions: lint, typecheck, tests (research guards required), build, Docker, compose security, gitleaks, CodeQL, production npm audit (high+ empty after Fastify 5 / protocol v0.6.0 Zod 4).

| Key / group | Meaning / units | Code default | Req | Validation | Scope | Unknown / fail |
| --- | --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | runtime | `development` (`test`/`production` allowed) | yes in prod semantics | enum | process | invalid → `ConfigError` |
| `HOST` / `PORT` | bind | `127.0.0.1` / `3700` (prod host `0.0.0.0`) | listen | port 1–65535 | process | |
| `CALLER_ISSUERS` / `SUBJECTS` | Hub JWT allowlist | `proba-hub` / `hub` | prod keys | list | inbound | unauth 401 |
| `HUB_SERVICE_PUBLIC_KEY_FILE` | Hub caller JWKS | empty; required in production | prod | file | inbound | refuse start |
| `HUB_ASSERTION_PUBLIC_KEY_FILE` | act-as verify JWKS | empty; required in production | prod | file | context | refuse start / unauthorized context |
| `LLM_BASE_URL` / `LLM_ALLOWED_HOSTS` | proba-llm | example `http://127.0.0.1:3600`; prod host default `llm` | prod | SSRF allowlist | outbound | unreachable |
| `LLM_TIMEOUT_MS` | ms | `60000` (100–300000) | no | int | outbound | abort |
| `GATEWAY_LLM_PRIVATE_KEY_FILE` / `KEY_ID` | mint to LLM | empty; required in production | prod | file | outbound | refuse start |
| `LLM_TOKEN_ISSUER` / `SUBJECT` / `TTL` | JWT | `proba-gateway` / `gateway` / `60` s, max `120` | no | ttl 1–120 | outbound | LLM 401 |
| `LLM_QUOTA_UNKNOWN_POLICY` | quota 404 | `allow_with_run_budget` | no | enum + `refuse` | brain | see §3 |
| `CONTEXT_BRIDGE_URL` / hosts / timeout | Context ping+build | example `http://127.0.0.1:3500`; timeout `10000` | prod URL; brain always requires ready | allowlist | brain | `context.ready` missing/unavailable/unauthorized; **zero** LLM |
| `CONTEXT_MAX_BUDGET_TOKENS` | protocol `budgetTokens` cap | `4000` in examples; code optional int | recommended | 1–1e6 | context fetch | |
| `ADS_DOMAIN_URL` | Ads HTTP | **empty** | no | allowlist if set | ads mutate | fail closed |
| `ADS_BILLING_REQUIREMENT` | ads funds | `billing_eligibility` | no | enum | spend-increase | unknown funds refuse mutate |
| `ADS_PREFLIGHT_FRESHNESS_MS` | evidence cache | `15000` (1000–300000) | no | int | preflight | stale Ads report |
| `RESEARCH_HTTP_FETCH` | opt-in public URL fetch | **false** | no | bool | research.gather | unconfigured provider fails closed; **no invented citations**. Context is not research |
| `RESEARCH_FETCH_TIMEOUT_MS` | fetch timeout | `5000` (100–30000) | no | int | research HTTP | abort |
| `RESEARCH_FETCH_MAX_BYTES` | untrusted body cap | `262144` | no | int | research HTTP | `untrusted_content` |
| `RESEARCH_STORE_DIR` | versioned review artifacts | `data/research` (empty in test) | prod | path | process | single-replica files, not Hub DB |
| `ANALYTICS_MAX_AGE_MS` | Context analytics freshness | `21600000` (6h) | no | int | evaluate | stale → `no_action`; unparseable asOf is unknown, not fresh |
| `ANALYTICS_MIN_IMPRESSIONS` / `MIN_OBSERVATIONS` | sample floors | `100` / `12` | no | int | evaluate | unknown is not a zero sample |
| `ANALYTICS_MIN_WINDOW_COVERAGE` | hourly-bucket fraction | `0.5` | no | 0–1 | evaluate | unknown coverage not assumed complete |
| `ANALYTICS_COOLDOWN_MS` | per-campaign decision cooldown | `21600000` (6h) | no | int | evaluate | durable file; not Hub cadence |
| `ANALYTICS_MAX_PROPOSAL_DAILY_BUDGET` | optional dry-run cap ceiling | **UNSET** (`null`) | no | positive number | evaluate | not a spend grant |
| `ANALYTICS_MAX_PROPOSAL_DECREASE_PCT` | max cap decrease fraction | `0.5` | no | 0–1 | evaluate | increases blocked |
| `ANALYTICS_STORE_DIR` | per-campaign decision files | `data/analytics` (empty in test) | prod | path | process | single-replica; in-memory refused in production |
| `ACTION_POLICY_STORE_DIR` | versioned owner action policies | `data/action-policies` (empty in test) | prod | path | process | in-memory refused in production; no live delegation |
| `ACTION_OUTCOME_STORE_DIR` | auto action cooldown/outcomes | `data/action-outcomes` (empty in test) | prod | path | process | single-replica |
| `ACTION_POLICY_COOLDOWN_MS` | default auto cooldown | `21600000` (6h) | no | int | ads auto | owner document may set a tighter limit |
| `GATEWAY_MAX_ITERATIONS` | loop | `8` (1–64) | no | int | run | exhausted |
| `GATEWAY_MAX_LLM_CALLS` | paid completes | `8` (1–64) | no | int | run | exhausted |
| `GATEWAY_MAX_TOOL_CALLS` | tools | `16` (1–256) | no | int | run | exhausted |
| `GATEWAY_MAX_PROMPT_TOKENS` | prompt cap | `null` | no | optional int | run | if set, hard stop |
| `GATEWAY_MAX_COMPLETION_TOKENS` | completion cap | `null` | no | optional int | run | if set, hard stop |
| `GATEWAY_MAX_TOTAL_TOKENS` | total tokens | `null` (example comments `8000`) | no | optional int | run + USD bound | required to bound prompt when USD cap set |
| `GATEWAY_MAX_COST_USD` | USD run ceiling | **`null` (UNSET)** | no | positive number | run | see §3 |
| `GATEWAY_GUARDRAILS_FILE` | operator guardrails file | `config/guardrails.json` (empty) | no | path | process | tighten-only; looser values refuse start-up (`src/guardrails/guardrails.ts`) |
| `GATEWAY_VERB_POLICY` | per-verb `allow\|ask\|deny` | unset | no | `verb=mode,...` | process | `deny` hides + refuses the verb; `ask` forces an approval card; never looser than the code or the file |
| `GATEWAY_GUARDRAIL_MAX_*` | per-run ceilings (ITERATIONS, LLM_CALLS, TOOL_CALLS, PROMPT/COMPLETION/TOTAL_TOKENS, COST_USD) | unset | no | positive | run | min() over deployment limits and the Hub run budget; must be <= file and `GATEWAY_MAX_*` |
| `GATEWAY_RESPONSE_TOKEN_RESERVE` | completion request + context subtract | `512` (0–128000) | no | int | each turn | |
| `GATEWAY_MAX_REQUEST_BYTES` | HTTP body | `262144` | no | 1024–2e6 | request | 413 |
| `GATEWAY_RATE_LIMIT_*` | inbound | 60 / 60000 ms | no | | process | 429 |
| `AUDIT_*` | Redis/log outbox | prod `redis`; content default **true** in gateway | prod redis URL | | run | log forbidden in production |
| `RUN_STORE_DIR` | local files | `data/runs` (`''` in test) | prod | | **single node** | second replica cannot see outbox (`deploy/stack.yml` comments) |

Swarm (`deploy/stack.yml`): `replicas: 1`, node label `proba.gateway=true`, stop-first updates, **local volume**. A reschedule onto another node can re-enter the loop on the same idempotency key.

Implemented vs planned: gateway **is** the bounded paid path (context → LLM → catalog tools → Hub approval → Ads domain). Ads domain HTTP is a port; provider adapters are **not** in this process. No mesh quota service.

## 5. CURRENT VERIFIED — proba-llm

Port **3600**. Only provider `deepseek`. Vendor key lives **here only**.

| Key / group | Default | Notes |
| --- | --- | --- |
| `LLM_PROVIDER` | `deepseek` | other values `ConfigError` (mocks test-only) |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_ALLOWED_*` | example + Swarm: `https://api.deepseek.com`, **`deepseek-flash`**, host `api.deepseek.com` | production requires URL, model, hosts, models, API key |
| Hub leftover default | Hub `DEEPSEEK_MODEL` default **`deepseek-chat`** (`proba-hub/src/config.ts` 163) | **stale vs llm example**; Hub path is not gateway |
| `LLM_TIMEOUT_MS` / `MAX_RETRIES` / `TOTAL_BUDGET_MS` | 60000 / 1 / 90000 | retries inside budget; never after HTTP 2xx |
| `LLM_THINKING` | `disabled` | `enabled` needs reasoning passback on tool turns |
| `LLM_TEMPERATURE` | `0` if unset | non-negative |
| `LLM_MAX_TOKENS` | `4096` (16–128000) | provider completion cap |
| `PRICE_PROMPT_USD_PER_MILLION` / `PRICE_COMPLETION_USD_PER_MILLION` / `PRICING_VERSION` | **UNSET / null** | omit → turn `cost.estimate=unknown`. No cache-hit/miss split in this config. |
| `GET /v1/quota` | **not implemented** | gateway treats 404 as unknown |
| `GET /v1/pricing` | **not implemented** | gateway treats 404 as unknown |
| Swarm | replicas 1, label `proba.llm=true`, local `TURN_STORE_DIR` | second replica can double-dispatch a paid provider call |

## 6. CURRENT VERIFIED — Hub

Port **3000** (platform local compose maps **3300**). Brain default **`mock`** / `MOCK_BRAIN_SCENARIO=happy_path`.

| Key / group | Default | Notes |
| --- | --- | --- |
| `GATEWAY_ENABLED` / `GATEWAY_URL` | off unless URL set | production must not combine with `BRAIN_PROVIDER=deepseek`; empty URL while enabled refuses start |
| `GATEWAY_TIMEOUT_MS` | 90000 | |
| `HUB_GATEWAY_TOKEN_TTL_SECONDS` | 120, clamped 1–120 | EdDSA `iss=proba-hub` `aud=proba-gateway` `sub=hub` |
| `gateway_runs` | migration 006 | durable command / idempotency / ask / runId. Hub PR publication of that work is **out of this repo** |
| Context bridge | on iff `CONTEXT_BRIDGE_URL` set; prod refuses enabled=false | `CONTEXT_BRIDGE_ON_FAILURE=clarify`; act-as Hub-minted, TTL ≤ 5 min (Hub docs) |
| `BRAIN_MAX_OUTPUT_TOKENS` / `TOOL_CALLS` | 1500 / 2 | Hub-brain proposal path |
| `BRAIN_MAX_ACTION_SPEND` / `PLAN_BUDGET` | **1000 / 10000 USD** | **ad-proposal** caps, 0 = no cap; not model token USD |
| Audit | `AUDIT_ENABLED=true`; Hub content default **false** | gateway content default true — producers differ |
| Auth | Firebase + session JWT; `DEV_LOGIN_ENABLED=true` off in production | |
| Durability | Postgres + Redis | vs gateway file store |

## 7. CURRENT VERIFIED — Context

Port **3500**. YAML `config/context.config.yaml` + env (`docs/CONFIG.md`).

| Group | Verified default | Fail / unknown |
| --- | --- | --- |
| Identity | `act_as_assertion`; `allowLocal: false` | production refuses local identity; missing act-as → gateway `context.ready` unauthorized (except `NODE_ENV=test`) |
| Budget | `defaultTokens: 6000`, `maxTokens: 12000` | P0 (policy/task/tools) over budget → `budget_exceeded_by_required` 422 |
| Needs | `maxRoundsPerStep: 2`, `extraTokenShare: 0.3`; analytics windows `1d,7d,14d,30d` | 90d refused |
| Source cache | **off** | memory cache per replica |
| Packet store | Postgres manifests, no item text, 7 day retention | production requires `DATABASE_URL` |
| Analytics source | enabled in YAML | metrics completeness is an **audit** limitation |
| Reload | `SIGHUP` YAML/templates/policy/tools | `cacheStore.backend` needs restart |

Gateway requires `goalId` + `threadId` + act-as (non-test) and a successful `/ready` or `/health` ping before paid LLM.

## 8. CURRENT VERIFIED — audit, memory, web, portal, platform

**Audit** (`proba-audit/.env.example`): Redis stream `proba.audit.events`; ClickHouse stores; metrics connectors default `meta:stub,google:stub` (stubs refused in production unless `ALLOW_STUB_CONNECTOR`). Content default **false**. API allow-lists empty = nobody. Chain anchors / leases `memory` locally, refused in production without real stores. **Analytics ingest is stub/incomplete for live ads.** Gateway can only **replay** its own unpublished audit outbox; it is not the audit system of record.

**Memory** (`proba-memory/.env.example`): Postgres+pgvector; embedder `openai-compatible` with empty URL (local platform uses `hash` / `scripted` LLM). Jobs default `decay` only. Context-reader role **off**.

**Web** (`proba-web/.env.example`): `VITE_API_BASE_URL=http://localhost:3000`; `VITE_AUDIT_API_BASE_URL` empty → charts unavailable; Firebase identifiers UNSET → sign-in unavailable; `VITE_DEMO_MODE=false`.

**Portal**: talks to audit-api (and optional memory); not the gateway paid path.

**Platform** (`proba/local/.env.example` + compose): localhost bind; `PROBA_SRC=main` snapshots **committed main** into images (uncommitted gateway work is **not** in `up.sh` main-mode images). Context/memory/portal are **profiles**. `GATEWAY_URL` is **not** set here. Hub scenario remains `happy_path` (no LLM).

## 9. CURRENT VERIFIED — limitations (constraints, not wishes)

1. **Gateway CI** (`.github/workflows/ci.yml` + `security.yml`): lint, typecheck, tests with required research-guard names, build, Docker image, compose loopback/`RESEARCH_HTTP_FETCH=false`, gitleaks, CodeQL, production npm audit (high+ must be **empty** after Fastify 5.12.8 + protocol `v0.6.0` / Zod 4.6.7). Do **not** add IDs to `scripts/prod-audit-baseline.json`. Do not npm-override Zod 4 onto protocol `v0.4.0`. CI does not enable live crawl or paid providers.
2. **Hub and LLM publication refusals** from earlier tasks remain final; this run does not retry them. Hub `gateway_runs` durability may exist on a Hub branch that is not merged from here.
3. **`GET /v1/quota` and `GET /v1/pricing` do not exist on proba-llm.** Gateway records `unknown`. Official DeepSeek list prices (below) are **not** loaded into `PRICE_*`.
4. **Paid path is opt-in** (`GATEWAY_URL`). Default Hub is mock brain. Enabling gateway with keys **can** spend at the vendor.
5. **Single-node file durability** for gateway runs and LLM turns. Swarm files say a second replica or node move can double-dispatch.
6. **Context is a hard prerequisite** for gateway brain (this PR). Act-as is Hub-minted; gateway does not mint it.
7. **Ads domain / provider bots are not implemented** in gateway. `ADS_DOMAIN_URL` empty fails closed. No Reddit/Microsoft/Google/Meta credentials here.
7b. **Research review is a gateway slice only.** Default `RESEARCH_HTTP_FETCH=false` (unconfigured, honest failure). `ads.create_campaign` cannot use a model-invented URL or skip an accepted current artifact. Hub/web/protocol UX is not in this repo (`docs/RESEARCH_REVIEW_CONTRACT.md`). No default landing URL.
8. **Analytics metrics/schema are incomplete** for live campaigns (audit stubs; Context analytics source can gap). Gateway `review_performance` now **evaluates** in-scope Context items (unknown ≠ 0) and emits audited report/no_action/blocked/dry-run proposal. It does not execute Ads, pay for LLM, or grant spend. Hub cadence/coalescing is documented in `docs/ANALYTICS_EVALUATOR.md` and is **not implemented in Hub here**.
8b. **Owner action policies** (`docs/ACTION_POLICIES.md`): default Hub **approval**. `auto_with_limits` is owner-published, scoped, versioned, and cannot relax auth/isolation/freshness/budget/URL acceptance or grant spend. Cap auto needs Hub `currentDailyBudget` (unknown is not zero). Cross-provider budget moves are denied as a side effect (`ads.move_budget` is catalogued but not allowlisted). Delegation cannot be enabled. Evaluator proposals are not execution authority on their own; an explicit Hub owner decision bound to the proposal is executed by `src/loop/approved-action.ts` (`docs/ANALYTICS_ACTIONS.md`). There is no env flag that globally enables auto.
9. **Approval persistence:** gateway stores pending approval on the run record; Hub owns the user ask. Cross-service resume bindings were a Hub task; treat as **implemented in Hub branch / untested end-to-end from this gateway PR**.
10. **Audit in gateway is producer + local replay**, not ClickHouse verification.
11. **No fictional real balance.** Unknown quota/cost/pricing/ad funds stay unknown.

## 10. Official vendor model prices (reference only — not Proba config)

Tracked configured model for **proba-llm** example/Swarm: **`deepseek-flash`**.

Fetched **2026-11-08** from DeepSeek’s own docs: [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/). Peak hours: 01:00–04:00 and 06:00–10:00 **UTC**, Monday–Friday, excluding Chinese public holidays; all other hours off-peak.

| `deepseek-flash` per **1M tokens**, USD | Off-peak | Peak |
| --- | ---: | ---: |
| Input cache **hit** | 0.003 | 0.006 |
| Input cache **miss** | 0.15 | 0.30 |
| Output | 0.60 | 1.20 |

Notes (verified on that page unless marked):

- Model version listed: DeepSeek-V4.1-Flash-1017. Legacy names `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` are billed at Flash rates.
- Concurrency limit listed: 2500 (vendor; **not** wired into gateway).
- Thinking mode exists; **separate reasoning-token rates are not listed** on that table. Treat thinking/reasoning as **unverified extra** unless billed as output.
- Search/Fetch APIs: $0.75 / 1k successful requests. **Gateway does not call them.**
- **Proba `PRICE_*` remains UNSET.** Do not copy these numbers into env from this document as a silent production activation.
- Hub still documents default `deepseek-chat` on its unused direct-brain path; that is **not** the llm-service example model.

## 11. PROPOSED — layered budgets (not implemented, not defaults)

Do **not** ship a single arbitrary run ceiling (including `$2`). Keep **token/request safety ceilings** (already implemented) separate from **user-facing spend experience**.

| Layer | Kind | Stop vs warn | Owner (proposed) | Status |
| --- | --- | --- | --- | --- |
| HTTP body / rate limit | safety | hard | gateway | **implemented** |
| Iteration / LLM / tool counts | safety | hard | gateway | **implemented** |
| Token caps + response reserve | safety | hard | gateway | **implemented** (total/prompt optional) |
| Explicit run USD cap | cost | hard, **only if set** and evaluable | gateway | **implemented this PR**; default UNSET |
| Workspace daily / monthly **model** USD | cost | warn then hard | Hub + audit rollup | **not implemented** |
| Per-workload envelopes (launch vs report vs optimize) | cost | warn / different caps | Hub stepType | **not implemented** |
| Human escalation | ads + spend-increase | approval | Hub | **implemented for catalog verbs**; not for model USD |
| Ad campaign daily budget | **ad spend** | provider + Ads domain | Ads | **not in gateway** |
| Infra (Redis, Postgres, ClickHouse, egress) | infra | ops | platform | out of model formula |

Policy already in code to preserve:

- `LLM_QUOTA_UNKNOWN_POLICY` (quota ≠ USD cap).
- Unset USD cap ⇒ unknown cost allowed under token/run caps.
- Explicit USD cap ⇒ no dispatch unless bound fits; unknown ≠ `$0`.

## 12. PROPOSED — planning formulas (labelled assumptions, not observed usage)

Let:

- \(R_{in}\) = USD / 1M **input** tokens  
- \(R_{out}\) = USD / 1M **output** tokens  
- \(P\) = prompt tokens on a turn (includes tools + growing context)  
- \(C\) = completion tokens on a turn  
- \(H\) = cache-hit fraction of **input** (0–1), **unknown until measured**

**Turn (if cache split is billed as DeepSeek docs):**

\[
\mathrm{USD}_{turn} = \frac{P}{10^6}\big((1-H)R_{in,miss} + H R_{in,hit}\big) + \frac{C}{10^6} R_{out}
\]

**Conservative planning bound** (no measured \(H\), peak window possible): use **peak cache-miss** input and **peak** output from §10: \(R_{in}=0.30\), \(R_{out}=1.20\) USD/1M for `deepseek-flash` as of 2026-11-08. If thinking is enabled and reasoning is billed as output, fold reasoning tokens into \(C\); if not documented, leave an **unknown adder**.

**Run:** \(\mathrm{USD}_{run} = \sum \mathrm{USD}_{turn}\) over up to `GATEWAY_MAX_LLM_CALLS` (default 8) turns, plus **zero** ad spend in this formula.

**Do not use** the user-reported tiny smoke of **1266 input / 2 output** tokens as a campaign benchmark. Tracked gateway smoke uses **fake** stub usage (`40/12` and `60/10` in `src/http/integration.smoke.test.ts`). That observation is a single short ping, not a workload.

### Workload sketches (assumptions explicit)

These \(P,C,N\) values are **planning placeholders**, not measurements.

| Workload | Assumed turns \(N\) | Assumed \(P\) / turn | Assumed \(C\) / turn | Why it grows |
| --- | --- | --- | --- | --- |
| Campaign setup + iteration | 4–8 (hits iteration cap) | 4k–20k (context packet + tools) | 256–512 (reserve 512) | tool results appended; approvals pause then resume |
| Analytics / report batch | 2–4 | 8k–40k if audit/analytics sections fill | 256–1024 | needs rounds (+30% tokens, max 2) |
| Optimization cadence | 1–3 / cycle | similar to report + prior decisions | 256–512 | retries on ambiguous turns **must not** redispatch (already) |
| Retry / tool-context growth | +1 turn per tool loop | \(P\) increases by tool JSON | — | `GATEWAY_MAX_TOOL_CALLS=16` is the safety lid |

**Illustrative conservative USD (peak miss rates, not a quote):**  
one turn with \(P=8000\), \(C=512\), \(H=0\):  
\(8000/1e6×0.30 + 512/1e6×1.20 ≈ 0.0024 + 0.00061 ≈ \$0.003\).  
Eight such turns ≈ **\$0.024**.  
A heavier report turn \(P=40000\), \(C=1024\): ≈ **\$0.013** each.

A **\$2 run cap** would be far above that conservative sketch **and** still the wrong UX: it is not workload-specific, is not a monthly workspace cap, and is **not** currently configured. A **\$2/day workspace** model budget might be tight or loose depending on volume; **do not set it until a measured trial exists**.

Ad spend (campaign daily budget, platform minimums) is **out of this formula**. No speculative vendor ad minimum is stated here.

Infra (hosting, Redis, ClickHouse) is **out of this formula**.

## 13. How to gather measured costs later (small bounded trial)

1. Keep `GATEWAY_MAX_COST_USD` **unset** unless `PRICE_*` and a prompt/total token cap are set so the cap is evaluable.
2. Set `PRICE_PROMPT_USD_PER_MILLION` / `PRICE_COMPLETION_USD_PER_MILLION` / `PRICING_VERSION` on **proba-llm** from the **then-current** vendor page (re-read; prices change). Prefer **peak miss** rates if the config cannot express cache split — that over-reports, which is conservative, and must be labelled.
3. User-approve a **short** gateway-enabled trial: one workspace, `GATEWAY_MAX_LLM_CALLS` kept at 8 (or lower), iteration cap 8, no ads mutate required.
4. Read turn `usage` + `cost` on gateway run snapshots and llm audit events (`brain.llm_call`). Record \(P\), \(C\), cached tokens if the vendor returns them, thinking on/off, stepType.
5. **Do not** scale 1266/2. Compute percentiles per `stepType`.
6. Only then propose workspace daily/monthly **model** envelopes and optional per-run USD. Activate **no** default in git.
7. Re-read https://api-docs.deepseek.com/quick_start/pricing/ on the trial date; if the model id is no longer `deepseek-flash`, stop and re-verify.

## 14. Source citations

| Item | Location |
| --- | --- |
| Gateway env load | `proba-llm-gateway/src/config.ts` |
| USD pre-dispatch bound | `proba-llm-gateway/src/usage/reservations.ts` |
| Quota unknown policy | `proba-llm-gateway/src/preflight/engine.ts`, `src/types/config.ts` |
| Context prerequisite | `proba-llm-gateway/src/preflight/graph.ts` (`context.ready`) |
| Swarm single-node warning | `proba-llm-gateway/deploy/stack.yml` lines 4–10 |
| LLM pricing unset | `proba-llm/src/config.ts` 144–148, `src/handler/single-turn.ts` `costOf` |
| LLM model example | `proba-llm/.env.example` 9–13, `proba-llm/deploy/stack.yml` 30–34 |
| Hub gateway opt-in | `proba-hub/.env.example` 77–93, `proba-hub/src/config.ts` 229–242 |
| Hub ad-proposal USD | `proba-hub/src/config.ts` 166–178 |
| Context YAML | `proba-context/config/context.config.yaml` |
| Context env | `proba-context/docs/CONFIG.md` |
| Platform local | `proba/local/.env.example` |
| DeepSeek list prices | https://api-docs.deepseek.com/quick_start/pricing/ (fetched 2026-11-08) |
| Production npm audit baseline | `proba-llm-gateway/scripts/prod-audit-baseline.json` (empty after Fastify 5 / Zod 4) |
| Protocol pin | `proba-llm-gateway/package.json` `github:smallseedlabs/proba-protocol#v0.6.0` |
| Analytics evaluator | `proba-llm-gateway/docs/ANALYTICS_EVALUATOR.md` |
| Owner action policies | `proba-llm-gateway/docs/ACTION_POLICIES.md`, `src/action-policy/` |
| Approved analytics actions, creative forwarding, E2E loop | `docs/ANALYTICS_ACTIONS.md`, `src/loop/approved-action.ts`, `src/loop/e2e-loop.test.ts` |

## creative.draft_post (brain-drafted Reddit post copy)

- The model drafts a Reddit TEXT post (`headline`, `body`, optional `rationale`, `claims[{text, findingId}]`). It always raises an approval card (code lock `ask`; guardrails may set `deny`, never `allow`).
- Checks before the card: headline ≤ 300 and body ≤ 10,000 chars (code locks); a code-locked banned-phrase list (e.g. "guaranteed", "#1", "risk-free", "clinically proven"); claim-like copy (percentages, prices, multipliers, user counts, superlatives) must cite findings of the **accepted** research artifact; any URL in the copy must be on the operator-entered landing host. The landing URL attached to the draft is always Hub `userSuppliedInput.landingPageUrl`; there is no default.
- Refusals are non-fatal tool results (`creative_invalid`, `research_not_accepted`) so the model redrafts or explains what is missing.
- The gateway saves nothing. Hub writes `goals.approved_creative` when the operator approves the card (with optional edits); `ads.create_campaign` then uses that saved copy via `userSuppliedInput.creative`, never the draft arguments.
- Guardrails file `creative` block (tighten-only): `maxHeadlineChars` (≤ 300), `maxBodyChars` (≤ 10,000), `bannedPhrases` (added to the code list; the code list cannot be removed). Looser values are refused at start-up.
