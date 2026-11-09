# Owner action policies (gateway)

Gateway-only. **Hub is not implemented here.** Scheduling, coalescing, and
proposal UX are a contract for a later Hub change. Hub/LLM publication
refusals remain final.

Test policy documents are labelled `FAKE: in-process owner action policy fixture`.

## Modes

| Mode | Meaning |
| --- | --- |
| `deny` | Verb is refused. No Ads call. |
| `approval` | Existing Hub resume gate (default when no matching owner document). |
| `auto_with_limits` | Skip **Hub approval only** for safe pause / cap-decrease after immutable preflight. Still uses the Ads domain port. Unconfigured Ads fail closed. **Never grants spend.** |

Default without a matching owner document: **approval**. There is no env flag
to activate auto globally (that would be live permission activation).
Delegation is **disabled** and cannot be published (`delegationEnabled` must
be `false`).

## Immutable gates (policy cannot relax)

- Workspace / user / tenant isolation (document `ownerUserId` must equal the
  run actor; other-workspace documents are ignored).
- Provider / account / campaign scope on the document.
- Fresh Context / Ads readiness (`phase: mutate` preflight still runs).
- `run.budget` token/iteration/USD caps.
- Exact `userSuppliedInput.landingPageUrl` + accepted research for create.

## Safe optimization boundaries

Auto is publishable only for `ads.pause_campaign` and `ads.update_campaign`.
Create/resume and any `spend_increase` are **clamped to approval** even if a
corrupt document says auto. Cap auto requires Hub/context
`command.payload.currentDailyBudget` (unknown current is not zero; the model
cannot supply it on tool args because the catalog is `additionalProperties:
false`). Cap auto cannot increase budget, cannot exceed `maxDecreasePct` /
`maxDailyBudget`, and cannot carry `name` or `landingPageUrl` (URL acceptance
stays Hub). Cross-provider / cross-account movement is **not a side effect**;
`ads.move_budget` exists in the catalog **not allowlisted**.

Evaluator `review_performance` dry-run proposals are **not** authority. Auto
pause policy does not execute Ads from the evaluator path.

## Durable audit / cooldown

Each decision emits `brain.decision_made` or `policy.denied` with `policyId`,
`policyVersion`, `mode`, `grantsSpend: false`. Successful auto execute writes
an outcome file (cooldown / restart). Same single-replica caveat as run store.

## Hub contract (not implemented in Hub)

When authorized later, Hub should:

1. Let the **owner** publish versioned policy documents (version starts at 1,
   increment-only). Gateway does not mint owner identity.
2. Coalesce operator reviews / auto-eligible pauses per
   workspace+user+campaign rather than firing a run per chat line.
3. Render `awaiting_approval` needs for `approval` mode. For
   `auto_with_limits`, there is no ask card — surface the audited auto
   outcome instead.
4. Never treat evaluator `dry_run_proposal` as approval or as Ads POST.
5. Not send `delegationEnabled: true` or `allowCrossProviderMove: true`.
6. For cap-decrease auto, send `currentDailyBudget` on the Hub command
   payload from owner-visible campaign state. Do not let the model invent it.

This gateway does not add a public policy HTTP API in this slice; tests inject
stores. Production uses `ACTION_POLICY_STORE_DIR` files.

## t140

Page creation and gVisor limb builders remain a **separate deferred phase**.
No hardcoded landing host.
