# MIC-166 acceptance — Multi-funder selection, preflight and independent jobs

Executed September 8, 2026. Scope: selection UI, per-funder preflight, frozen deal/document versions, one independent job per funder, transactional outbox, unique confirmation keys, and replacement of the fail-closed `queueSubmissions` port. Live email sending remains a later ticket.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| One rejected destination does not stop valid destinations | Passed | `tests/submissions-core.test.ts` — email route delivers independently (`failed` via Wave 0 transport stub) while missing route is `preflight_failed`; both jobs, outbox rows, and display-cache rows exist |
| Repeated confirmation creates no duplicate external request | Passed | Same `confirmationKey` / `analysisRunId` returns the same job ids; `mca_submission_attempts` stays at 1 for the email job and 0 for preflight-failed |
| Frozen deal version and document checksums | Passed | Job rows store `deal_version` and `document_versions_json` containing the uploaded PDF checksum |
| Email without a usable submission sender | Passed | Other workspace with no sender: email destination `preflight_failed` (sender) independently of missing-route `preflight_failed` |
| Loading / empty / validation / success / failure UI | Passed | `SelectionPanel` loading copy, empty funders, client+API “select at least one funder”, success status, and request-error alert |
| Direct API permissions match UI; secrets excluded | Passed | `deals:read` GET 200; `deals:read` and `intake:write` POST 403; `deals:write` POST 200; forged workspace 404; responses omit SMTP password / `credentialCipher` |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-core.test.ts
```

4/4 passed.

## Behavior

- Confirm (`deals:write`) creates one `mca_submission_jobs` row per funder with unique `(workspace_id, confirmation_key, funder_id)` and a matching `mca_submission_outbox` row.
- Missing/inactive route, inactive funder, or unusable submission-purpose sender → `preflight_failed` for that destination only. `assertSenderUsable` failures do not crash the batch.
- Passing preflight calls `assertDuplicatePolicy` (allow-all), then `prepareOutgoingPackage` and `deliverSubmission`. Unique `(job_id, attempt_key)` prevents a second attempt on replay.
- `queueSubmissions({ actor, dealId, funderIds, analysisRunId })` returns `{ ok: true, jobs }` and uses `analysisRunId` as `confirmationKey` when present.
- `deal_submissions` cache: `funder_name`, `funder_id`, `job_id`, `route_kind`, `status` (`sent` / `queued` / `errored`).
- Reads: `deals:read`. Writes: `deals:write` with `assertTrustedMutation`. Admin not required. `intake:write` 403. Cross-workspace deal ids 404. `cache-control: no-store`, `runtime = "nodejs"`.

## UI

`SelectionPanel` covers loading, empty (no funders), validation (no selection), success (independent job states), and failure (request error). Conductor mounts it on the deal workspace.

## Local vs live gates

Local Postgres fixtures prove independent jobs, idempotent confirmation, freeze, outbox, and ACL. Email/API/webhook transports are still Wave 0 stubs (`provider_unavailable` except portal → `pending_portal`). Fixture success is not production sending readiness.
