# Analytics evaluator (gateway `review_performance`)

Gateway-only slice. Hub, Ads, LLM, page generation, and gVisor limb builders
are **not** in this PR. Decisions **never grant spend**. There is no Ads POST
and no paid `POST /v1/complete`.

Context packets and audit events are consumed **read-only** from the existing
protocol contracts (pin `github:smallseedlabs/proba-protocol#v0.4.0`). This
process does not write sibling DBs.

Test Context packets are labelled `FAKE: in-process analytics context fixture`.

## What this slice does

Hub `stepType: review_performance` is `read_or_plan`. The bounded loop takes
preflight `phase: evaluate` (requires `context.ready`, **not** `llm.quota`)
and runs a deterministic evaluator on the analytics section of the Context
packet.

Outcomes (always `grantsSpend: false`):

| Outcome | Meaning | Run status |
| --- | --- | --- |
| `report` | In-scope metrics passed freshness / sample / coverage gates | `completed` |
| `no_action` | Missing metrics, stale sample, cooldown, insufficient coverage | `completed` |
| `blocked` | Scope mismatch, unknown freshness, stale campaign version, proposal bounds | `blocked` |
| `dry_run_proposal` | Evidence-only pause or cap **proposal**. Not Hub approval. Not Ads mutate | `completed` |

Each outcome is published through the existing audit pipeline as
`brain.decision_made` (protocol 0.4.0 catalog; `analytics.evaluated` is
architecture-planned and is **not** invented here). Details include
`outcome`, `grantsSpend: false`, `dryRun`, gate code, and proposal
`argsHash` when present.

Missing/null metric numbers stay **`unknown`**. They are never coerced to 0.

## Deterministic gates

Fail closed, in order:

1. Packet `workspaceId` / `userId` must match the Hub run (tenant + actor).
2. Campaign metrics items must match Hub `platform`, `accountId`,
   `providerCampaignId`, `probaCampaignId` when those fields are present.
   Items that exist but do not match are `scope_campaign` (blocked), not a
   silent empty report.
3. `asOf` freshness (`ANALYTICS_MAX_AGE_MS`, default 6h). Unparseable asOf
   is `unknown_freshness` (blocked), not "fresh".
4. Sample: impressions **or** observationCount must meet minima. Both
   unknown → `unknown_sample` (not a zero sample).
5. Window coverage from observationCount vs expected hourly buckets
   (`ANALYTICS_MIN_WINDOW_COVERAGE`, default 0.5). Unknown coverage is not
   assumed complete.
6. Per-campaign cooldown (`ANALYTICS_COOLDOWN_MS`, default 6h) from the
   durable decision store (workspace + user + probaCampaignId). Cooldown
   and stale-version failures do **not** refresh cooldown or overwrite a
   newer `asOf`.
7. Incoming `asOf` must not be behind the last persisted campaign decision
   version (`stale_decision`).
8. Proposal bounds: `propose_cap` requires positive `dailyBudget` and known
   `currentDailyBudget`. **Increases are blocked** (that would grant spend).
   Decreases may not exceed `ANALYTICS_MAX_PROPOSAL_DECREASE_PCT` (default
   0.5). Optional `ANALYTICS_MAX_PROPOSAL_DAILY_BUDGET` is an extra ceiling,
   not a spend grant.

Run-store idempotency still replays the same Hub `Idempotency-Key`. The
analytics store is a separate per-campaign cooldown / version file (same
single-replica caveat as `RUN_STORE_DIR`).

## Hub integration contract (cadence / coalescing required later)

**Do not implement cadence in Hub in this PR.** Hub publication of that
work was refused and stays refused. This is the contract Hub must satisfy
when that work is authorized:

### Request (`POST /v1/runs`, `stepType: review_performance`)

Structured `command.payload` fields — **not** free text in `send_message.text`:

| Field | Required | Notes |
| --- | --- | --- |
| `probaCampaignId` | strongly recommended | Gateway cooldown key when present |
| `platform` | when scoping a provider | `reddit` / `microsoft` / `google` / `meta` |
| `accountId` | when scoping an ad account | Must match Context item |
| `providerCampaignId` | when scoping the provider campaign | Must match Context `campaignId` |
| `reviewIntent` | no (default `report`) | `report` \| `propose_pause` \| `propose_cap` |
| `dailyBudget` | `propose_cap` only | Positive number; missing is unknown, not 0 |
| `currentDailyBudget` | `propose_cap` only | Required so a decrease can be proven; increases refused |
| `currency` | with cap | Passed through to the dry-run args hash |

Also required for Context: `workspaceId`, `userId`, `goalId`, `threadId`,
`actAsAssertion` (except `NODE_ENV=test`).

### What Hub must **not** do with the snapshot

- Treat `dry_run_proposal` as `awaiting_approval` or as authorization to
  `POST` Ads / the provider. It is **evidence only**.
- Treat any evaluator outcome as a spend grant (`grantsSpend` is always
  false; Hub must not infer spend from `ads.update_campaign` in a dry-run
  args hash).
- Fill missing Context metrics with zero before calling the gateway.
- Retry the same review on every message without **cadence and coalescing**
  (Hub-side; required later). Gateway cooldown is a backstop per campaign,
  not a substitute for Hub coalescing across threads/steps.
- Expect this gateway to call LLM, Ads, or a page builder.

### Cadence / coalescing (Hub, later)

When authorized, Hub should:

1. Coalesce multiple `review_performance` intents for the same
   `workspaceId` + `userId` + `probaCampaignId` into one gateway run per
   cooldown window.
2. Pass a stable idempotency key for an identical payload (gateway run
   store replays).
3. Use a **new** key only when the review is a distinct attempt after
   cooldown or with a newer Context `asOf`.
4. Surface `report` / `no_action` / `blocked` / dry-run proposal text to
   the operator without auto-executing verbs.

Gateway does not enqueue Hub jobs, write Hub tables, or retry Hub PRs.

## t140 — page creation and gVisor limb builder (deferred)

**Not in this PR. Do not build those services now.**

- Page creation and a gVisor limb builder are a **separate phase**.
- Landing / page URL origin must be an **external user-supplied URL** or a
  **future page service** with explicit provenance and validation.
- **No hardcoded host** (including no `smallseedlabs.com` default).
- Extensible origin: the URL is an input with provenance, not a compiled-in
  destination. Validation belongs at the boundary that accepts the URL
  (existing research `userSuppliedInput.landingPageUrl` / future page
  service), not a new host allowlist of product domains.

## Fastify / Zod highs (honest)

This PR does **not** broaden `scripts/prod-audit-baseline.json`. The existing
fastify 4 / zod 3 high GHSAs are a **documented baseline, not a security
clearance**. Later remediation (fastify 5 / protocol zod 4) is required.
New high+ GHSA IDs still fail CI. Do not treat `npm run audit:prod` passing
as “no highs”.
