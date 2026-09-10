# MIC-166 review — Multi-funder selection, preflight and independent jobs

**Spec:** PASS
**Quality:** Approved (Minor)

Live email/API/webhook transport remains Wave 0 `provider_unavailable` (MIC-153). Fixture success is not production sending. No live merchant submissions. Do not mark Linear Done from this review.

## Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| One rejected destination does not stop valid destinations | Pass | `queue.ts:203-226` try/catch per funder. Missing route is `preflight_failed` while email still delivers (`preflight.ts:72-75`, `queue.ts:166-195`). Test: `tests/submissions-core.test.ts:215-255` (broken `preflight_failed`, email `failed\|queued\|sent`, two jobs + outbox + cache). Sender-less workspace: email vs missing-route both `preflight_failed` independently (`327-364`). |
| Repeated confirmationKey creates no second external request | Pass | Unique `(workspace_id, confirmation_key, funder_id)` insert `ON CONFLICT DO NOTHING` (`repository.ts:177-207`; schema `db/schema.ts:1354`). Replay returns existing job and skips delivery (`queue.ts:193-195`). Attempt unique `(job_id, attempt_key)` (`repository.ts:266-270`). Tests keep attempt count 1 / 0 (`submissions-core.test.ts:254-271`, `315-324`). Port uses `analysisRunId` as confirmationKey (`submission-port.ts:14-20`). |
| Permissions: `deals:write` confirm, `deals:read` list, `intake:write` 403; admin not required | Pass | `queue.ts:285-289` scopes only; no admin roles. GET `deals:read`, POST `deals:write` + `assertTrustedMutation` (`[dealId]/route.ts:10-39`). Tests: GET 200, intake/read POST 403, write POST 200, forged workspace 404 (`367-409`). |
| `deal_submissions.funder_name` is display cache; matching uses funder IDs | Pass | Cache write sets name + `funder_id`/`job_id`/`route_kind` (`repository.ts:358-418`). Job lookup is `workspace_id + confirmation_key + funder_id` (`155-164`). |
| Freeze deal version + document checksums at confirmation | Pass | `jobs.ts:24-29`, persist `dealVersion`/`documentVersions` (`repository.ts:194-196`). Test stores `deal.version` and PDF checksum (`submissions-core.test.ts:240-243`). |
| Transactional outbox row per job | Pass | `persistNewDestination` wraps job + outbox + cache (`repository.ts:385-412`). Test count 2 (`245-248`). |
| `assertDuplicatePolicy` then `prepareOutgoingPackage` then `deliverSubmission` | Pass | Policy always called (`queue.ts:156-162`; Wave 0 allow-all `duplicate-policy.ts:7-16`). Passing queued jobs call package then deliver (`outbox.ts:64-79` via `ports.ts`). Route kinds `email\|api\|manual_portal\|custom_webhook` (`deliver.ts:11-29`). |
| `queueSubmissions` returns `{ ok: true, jobs }`; analysis call shape | Pass | `submission-port.ts:8-21` `{ actor, dealId, funderIds, analysisRunId }`. Result type `ok: true` (`contracts.ts:57-59`). |
| Loading/empty/validation/success/failure UI | Pass | Loading (`selection-panel.tsx:170`), empty funders (`173-177`), client “Select at least one funder” (`126-129`) + API 422 (`queue.ts:66-67`, test `287-292`), success copy/badges (`139-143`, `228-239`), request-error alert (`171`). |
| Direct API matches UI; logs/JSON omit secrets | Pass | Same queue for HTTP and port. `assertNoSecret` on GET/POST (`submissions-core.test.ts:174-178`, `282`, `305`, `376`, `385`). Audit metadata has ids/state only (`queue.ts:115-130`). |
| Exclusive files; no flag leakage | Pass | Implementation is the brief exclusive set plus conductor mounts. API tree is only `[dealId]/route.ts` (no `portal/**` etc.). `duplicate-policy.ts` / `stamps.ts` untouched Wave 0 stubs. |
| Conductor mounts | Pass | Submissions tab renders `SelectionPanel` (`deals-workspace.tsx:30`, `243`). Analysis maps `queuedJobs.ok` to `queued` (`analysis.ts:334-342`). |

## Quality

Approved. Minor only:

1. Replay of a job that was inserted as `queued` but never delivered skips `processJobDelivery` (`queue.ts:193-195`). There is no outbox consumer besides the confirm path (`outbox.ts:35`). A crash after `persistNewDestination` would leave a queued row that replay will not send. Completed attempts stay idempotent (attempt count 1).
2. Unknown funder IDs return an ephemeral `preflight_failed` summary without a persisted job (`queue.ts:147-153`) to avoid the funder FK. Replay of those IDs is not idempotent. Tests cover missing *route*, not missing *funder*.
3. Implementer report handoff is stale: `analysis.ts` already remounts `{ ok: true, jobs }` to `queued`. Automatic send no longer fail-closes at the port.
4. HTTP confirm is tested with admin session and `deals:write` API key; the seeded rep session is unused. Session auth does not check scopes (`auth.ts:93-96`), so any signed-in member can confirm — matches “admin not required,” untested via cookie.
5. Confirm button stays enabled with an empty selection; validation is on click + 422. Acceptable.

No Critical or Important defects on the exclusive surface.

## Unverified claims

- **4/4 passed:** the test file defines four `test("MIC-166:…")` cases matching the report; this review did not re-execute Postgres.
- **Did not edit `duplicate-policy.ts` / `stamps.ts` / `schema.ts` / `deals-workspace.tsx` / `analysis.ts`:** current stubs, unique constraint, and mounts match the brief; the repo has no git, so in-place rewrites cannot be proven.
- **Live email delivery (MIC-153):** not production-verified (documented remaining gate).
