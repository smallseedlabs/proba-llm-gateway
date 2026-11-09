# Analytics and action bot: gateway side

This covers the gateway half of the loop *metrics → evaluator proposal → owner
decision → Ads action*, plus forwarding of operator-approved creative and
accepted research to Ads. Hub scheduling and the Web review UI live in their
own repos.

Nothing here grants spend, enables delegated automatic actions, or calls a
provider directly. Ads remains the only process that talks to Reddit (and only
when its own Reddit adapter is explicitly enabled).

## 1. Evaluator summary on the run snapshot

`review_performance` snapshots now carry `analytics`:

| Field | Notes |
| --- | --- |
| `decisionId`, `outcome`, `asOf` | `outcome` ∈ `report` / `no_action` / `blocked` / `dry_run_proposal` |
| `grantsSpend` | always `false` |
| `probaCampaignId`, `platform`, `accountId`, `providerCampaignId` | the evaluated scope |
| `reviewWindowUntil` | proposals can only be acted on before this instant |
| `metrics[]` | per-item impressions/clicks/spend/conversions; missing stays `"unknown"` |
| `unknownMetrics`, `gate` | why the evaluator did not propose |
| `proposal` | `{ dryRun: true, grantsSpend: false, verb, args, argsHash }` (pause or cap decrease) |

A proposal is still **evidence only**. Hub must show it to the owner.

## 2. Executing an approved proposal

Hub sends `POST /v1/runs` with `stepType: handle_approval`, a structured
`command.payload.analyticsAction`, and a `resume` bound to the proposal:

```json
{
  "stepType": "handle_approval",
  "command": { "type": "send_message", "payload": {
    "text": "approved analytics action",
    "analyticsAction": {
      "proposalId": "<Hub proposal uuid>",
      "decisionId": "<evaluator decisionId>",
      "verb": "ads.pause_campaign",
      "args": { "probaCampaignId": "…" },
      "argsHash": "<proposal argsHash>",
      "probaCampaignId": "…", "platform": "reddit", "accountId": "…"
    } } },
  "resume": { "askId": "<proposalId>", "choice": "approve" }
}
```

`src/loop/approved-action.ts` runs deterministically (zero LLM calls) and fails
closed unless **all** of these hold:

1. `resume.askId === proposalId`. Absence is not approval; `reject` is audited
   and nothing is sent to Ads.
2. Verb is `ads.pause_campaign` or `ads.update_campaign` (cap). `ads.move_budget`
   and anything else is refused (`verb_not_allowed`).
3. `canonicalArgsHash(args) === argsHash` and `args.probaCampaignId` matches.
4. The proposal is the **latest** persisted evaluator decision for the same
   workspace + user + campaign (`decisionId`, `outcome=dry_run_proposal`,
   `argsHash`), and the review window has not passed (`proposal_expired`).
5. Provider and account recorded at evaluation match the request
   (`scope_provider`). The action affects exactly one Proba campaign on one
   provider account; moving budget across providers is a separate, explicit,
   non-allowlisted operation.
6. Owner policy `deny` still wins. Mutate preflight still runs (fresh Ads
   readiness; billing for spend-class verbs — a cap change is treated as a
   spend-class update, so it needs a verified billing claim; pause does not).

Ads receives Ads-shaped args only (`currency` stays proposal evidence). The
run store replays the same Hub idempotency key without re-executing. Each step
is audited (`brain.decision_made` / `policy.denied` with `evaluator:
approved_action`, `approval.rejected`, `tool.executed` / `tool.failed`), and a
successful action writes an `approved_executed` outcome record.

Delegated automatic actions are unchanged: `delegationEnabled` must be
`false`, there is no env flag to turn auto on, and the evaluator path never
executes on its own.

## 3. Creative and research forwarding on create

`userSuppliedInput` (Hub → gateway) accepts two optional operator-approved
fields next to `landingPageUrl`:

- `creative`: `TEXT { headline, body }` or `IMAGE { headline, body?, mediaUrl, callToAction? }`.
- `targeting`: Reddit targeting object (Ads validates the shape).

The model cannot author either: they are not tool parameters. Policy injects
them into `ads.create_campaign` args, so the Hub approval hash covers the exact
copy/media. Create is refused without approved creative. Ads creates the
Reddit structured post from it and uses the returned post id for the ad.

After confirming the accepted research artifact for the exact URL revision,
the dispatcher adds `researchAcceptance { artifactId, version, inputRevision }`
and `researchAttestation { status: "accepted", landingPageUrl, acceptedAt,
sourceCount, findingCount }` for Ads to verify. These are not part of the
approval hash. There is still no default landing URL.

## 4. Isolated end-to-end loop test

`src/loop/e2e-loop.test.ts` drives the real coordinator through
portal input → research → acceptance → create → metrics → proposal → approved
pause. Model turns (`ScriptedLlmClient`), research (`SourcedResearchProvider`),
Context metrics (FAKE analytics fixture) and Ads (`RecordingAdsDomain` TEST
STUB) are fakes. No paid model, provider or network call is made.
