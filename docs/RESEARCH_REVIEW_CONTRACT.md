# Research review contract (gateway slice)

This is **not** the full product. Gateway-only: source-backed research artifacts and a create-campaign guard. Hub, protocol, web, and persistence of operator UX are follow-up repos.

Context packets remain **existing-data retrieval**. They are not web research and are not citations.

There is **no default landing URL** (including no `smallseedlabs.com`).

## Compatible Hub → gateway request

Optional field on `POST /v1/runs` (`HubRunRequest`):

```json
{
  "userSuppliedInput": {
    "landingPageUrl": "https://operator-entered.example/path"
  }
}
```

- Omitted: current Hub clients still validate. `research.gather` and `ads.create_campaign` **fail closed** (`user_input` / `research.accepted` missing).
- Required for those verbs: exact operator URL, bound to `workspaceId` + `userId` + `goalId` + `threadId`.
- Fingerprinted with the run (not with `resume`). Changing the URL on the same idempotency key is a conflict.
- `resume.values` still cannot replace bound tool args or the user URL.

## Gateway behavior (implemented)

| Step | What happens |
| --- | --- |
| `research.gather` | Uses `userSuppliedInput.landingPageUrl` only. Calls `ResearchProviderPort`. Unconfigured → honest failure, **no invented citations**. Stores a versioned artifact (`findings` must cite `sources`). |
| After gather | Snapshot `awaiting_approval` with `needs[0].verb = research.accept` and a redacted research summary. Not an LLM tool. |
| Hub `resume.choice=approve` | Marks **this** artifact version accepted. |
| `edit` | Invalidates acceptance. Create stays blocked until gather+accept of the **current** URL revision. |
| `reject` | Leaves artifact unaccepted. |
| `ads.create_campaign` | Mutate preflight + dispatcher require accepted artifact for this workspace/user/goal/thread **and** URL revision. Tool `landingPageUrl` must equal the user URL. |

`RESEARCH_HTTP_FETCH` default **false**. Opt-in fetch: public http(s) :80/:443 only, no credentials, no redirects, DNS/IP must be public, body untrusted. Not a paid ad action.

## Hub / web / protocol follow-up (not this PR)

1. **proba-web (not portal):** landing URL field on goal/campaign entry. Portal stays Insights admin.
2. **proba-protocol:** optional `userSuppliedInput` on the command or a dedicated research ask type (`askType` is still only clarify/plan/action). Findings/assumptions/unknowns schema if Hub persists them.
3. **proba-hub:** collect URL from web; send `userSuppliedInput` + `goalId`/`threadId` on gateway runs; render `research.accept` needs (findings, assumptions, unknowns, sources) instead of a generic budget card; `edit` must change URL via a **new** input revision or re-gather; do not treat Context as research.
4. Persistence of the review UX beyond gateway `RESEARCH_STORE_DIR` (single-replica files, same caveat as run store).
5. Ads domain / providers stay out of this slice (separate Ads security work).

## What this slice does not claim

- Operator UI, protocol events, or Hub mock-brain research.
- Live vendor page crawl in default config.
- Automatic research on `launch_campaign` brain (that step still requires Ads readiness; gather on `interpret_message` / plan steps).
- Replacing Hub human approval for spend.
