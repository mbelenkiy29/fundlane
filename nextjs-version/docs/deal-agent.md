# Deal Agent (Deal Desk Autopilot v1)

When a clean document lands on a deal, the Deal Agent reruns the existing statement analysis, completeness check and lender fit, then queues proposed actions for a broker: a missing-documents request to the merchant, a calendar follow-up, and submission drafts for the top matched funders. **The agent never sends anything.** Every external effect happens only when a signed-in broker approves an action, and it goes through the same code path as the manual button.

No LLM is added; the only model use is the existing statement extraction provider.

## Flags (both default off)

| Flag | Where | Effect |
| --- | --- | --- |
| `MCA_DEAL_AGENT_ENABLED=true` | Environment (exactly `true`) | Global kill switch for enqueue, job processing, `deal_agent` in the default cron kinds, the API and the panel. |
| `featureFlags.dealAgent` | Settings → Workspace → "Deal Agent" switch (admins) | Per-company opt-in. Existing companies read as off. The switch is shown only when `GET /api/workspace` returns `featureAvailability.dealAgent.available: true`, which follows `MCA_DEAL_AGENT_ENABLED`; with the env flag off it is hidden and the stored value is kept unchanged. |

Workspace autonomy settings (`mca_analysis_settings.mode = automatic_send`, auto-submit `auto_submit`) do not affect the agent: the job contains no send calls, and its completeness check passes `skipAutoSubmit` so a deal it finds ready is not handed to auto-submit.

## Trigger and run

1. `completeDocumentUpload` (every upload source) reaches a clean scan. With both flags on it enqueues `kind=deal_agent`, `resource_id=<dealId>`, idempotency key `deal-agent:<documentId>`, available 120 seconds later so multi-file uploads and the intake job settle. If the deal already has a queued (unclaimed) `deal_agent` job, that job's `available_at` is pushed to now + 120 seconds instead, never more than 10 minutes after the job was created, so a steady stream of uploads cannot starve the run. Enqueue failures are logged as `deal_agent_enqueue_failed` and never fail the upload.
2. The worker re-checks the flags and skips deals outside `lead`…`resubmitting`.
3. The run is claimed by `input_key` (hash of the deal's ready documents as `category:checksum`) with `INSERT … ON CONFLICT`. Identical inputs, duplicate jobs and retries are no-ops (`{skipped:"unchanged"}`); a failed or stale (10 min) run is reclaimed by the retry.
4. Steps, each recorded in `mca_deal_agent_runs.steps_json` as it finishes: `statements` (skipped when no extraction provider), `completeness`, `lender_fit` (only when complete: `scoreDeal` analyze-only + `getLenderFit`, top N from the workspace analysis settings), `proposals`, `write`.
5. `write` takes a per-deal advisory lock, supersedes stale pending proposals and inserts new ones. A proposal's identity is target + fingerprint (`c<completenessVersion>` or `s<scoreSnapshotId>`), so a dismissed or approved proposal is not re-proposed until its inputs change. A reviewed proposal (pending with a stored preview) is never replaced: a newer proposal for its target is parked on it (`next_fingerprint`/`next_payload_json`, `error_code=inputs_changed`) unless that fingerprint was already dismissed or approved, and a target the run no longer proposes gets `error_code=no_longer_suggested`. The broker can approve exactly what they reviewed, review again (which promotes the parked proposal first), or dismiss (which inserts the parked proposal as a new pending row). Follow-ups have no review step and are always replaceable.

## Actions

| Kind | Proposed when | Review (no external effect) | Approve |
| --- | --- | --- | --- |
| `request_documents` | Completeness has missing application / ID / voided check / statement months (months are not requested while an uploaded statement has an unknown period) | Creates (or reuses still-open) stipulations and the existing closing request preview (needs a verified merchant sender) | `sendRequestPreview` — secure `/merchant-upload/` links, delivery ledger |
| `schedule_follow_up` | With every document request | — | `saveActivity` follow-up for the approver, all-day, +2 days in the company timezone |
| `submit_to_funder` | Complete deal; matched funder within top N; preflight clean; no prior non-failed submission | `prepareDealSubmission` exact package preview | `confirmSubmissions` with that preview (duplicate guard, broker-approved delivery) |

States: `pending → executing → approved | failed`, `pending → dismissed`, `pending → superseded`. A 4xx from the send path (stale preview, unusable sender…) returns the action to `pending` with `error_code`; anything else marks it `failed` — check the Submissions/Closing records. Nothing is re-sent automatically.

An action left `executing` for more than 15 minutes (the process died mid-approval) is recovered when the panel loads or a run writes proposals, from the downstream record: a confirmed submission preview, a `sent`/`failed` closing preview, or a matching follow-up activity for the approver marks it `approved`/`failed`; otherwise it returns to `pending` with `error_code=interrupted` and the broker approves again (confirm and delivery are idempotent). Every write is guarded by `status='executing' AND updated_at<cutoff`, so a slow live request is never overwritten.

Dismissing a document request waives the stipulations that action created that are still open (`idempotency_key` prefix `deal-agent:<actionId>:`); stipulations reused from an earlier request stay open. Reviewing again after a newer proposal was parked does the same for the items the new version no longer asks for; items in both versions keep their stipulation, which the new preview reuses.

Every decision writes an audit event (`deal_agent.action_reviewed|approved|dismissed|failed|recovered`, `deal_agent.run_completed`, and `closing.stipulation_waived` per waived stipulation).

## Permissions

`GET/POST /api/mca/deal-agent/[dealId]` uses `requireClosingActor`: `deals:read` for GET; POST requires an interactive session, `deals:write` and the Deals page. The deal must be visible to the user (reps see their own deals); another company's deal or action is a 404. Submission review/approve additionally require a broker (`assertBroker`), the document request requires a usable merchant sender, and follow-ups use the calendar's own assignment checks. The client sends only `{actionId, decision, senderId?, note?, previewId?}`; `previewId` is only compared with the stored preview (409 `preview_changed` if someone reviewed again elsewhere), never used as the thing to send.

## Migration and rollout

- Migration `drizzle/0082_deal_agent.sql` is additive (two tables including the nullable `next_fingerprint`/`next_payload_json` columns, RLS + `mca_app` grants, policies guarded by `pg_policies` so a re-run is safe). Apply it through the reviewed release process before setting the flag; it depends on the `deals_workspace_id_id_unique` index from `0071`.
- Rollback: unset `MCA_DEAL_AGENT_ENABLED` (or turn the workspace switch off). The cron runtime stops claiming `deal_agent`; any queued job a worker still claims completes as `{skipped:"disabled"}`. Pending rows remain and reappear in the panel if re-enabled.
- With `MCA_JOB_RUNTIME=vercel_cron`, `deal_agent` is in the default runtime kinds when the flag is on; it needs no scanner.

## Verification

```bash
node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 \
  tests/deal-agent.test.ts tests/job-runtime-kinds.test.ts
```

Hosted acceptance (cron ownership, a real merchant sender, Supabase Storage uploads, the browser flow) needs an approved nonproduction environment with synthetic records.
