# MIC-174 review — Duplicate blocking and controlled retry (2 min / 24 h)

**Spec:** PASS
**Quality:** Approved (Minor)

Live email/API/webhook transport remains Wave 0 stubs. Fixture success is not production sending. No live merchant submissions. Do not mark Linear Done from this review.

## Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| Error retries blocked within 2 minutes; allowed at the boundary | Pass | `duplicate-policy.ts:8,57-66`: `failed` / `preflight_failed` block while `now < updated_at+2m` (`retry_too_soon`). Exact `eligibleAt` is allowed (`now <` not `<=`). Test: `submissions-duplicates.test.ts:246-270` (`T0+2m-1` `blocked_duplicate`, `T0+2m` new failed job). |
| Non-errored active duplicates blocked inside 24 hours; allowed at the boundary | Pass | `duplicate-policy.ts:9,69-78`: `queued` / `sending` / `sent` / `pending_portal` block until `created_at+24h` (`active_duplicate`). Test: `273-300` (`T0+2m` and `T0+24h-1` blocked, `T0+24h` new `pending_portal`). |
| Block responses include ISO `eligibleAt` | Pass | Decision sets `eligibleAt` and copies it into `reason` (`duplicate-policy.ts:59-65,70-76`). Queue stores `duplicate.reason` as job reason (`queue.ts:169-171`). Tests assert ISO equality and reason substring (`254-264`, `279-288`, `401`). |
| Privileged retry requires `privilegedRetry` + non-empty `privilegedReason`; prior jobs retained | Pass | Both required after trim (`duplicate-policy.ts:206-218`). Flag-only or whitespace falls through to the normal block (`330-344`). Reasoned override is `privileged_retry` and inserts a second job; original `pending_portal` row remains (`346-366`). |
| Concurrent submits produce one accepted attempt | Pass | `pg_advisory_xact_lock` + `FOR UPDATE` on jobs/claim (`duplicate-policy.ts:193-200`) and durable `submission.duplicate_claim` for the persist gap (`99-112,163-169`). Test: two confirmation keys → one `pending_portal` (1 attempt) and one `blocked_duplicate` (0 attempts) (`302-319`). |
| Other destinations remain independent | Pass | Policy key is workspace + deal + funder (`114-121,194-195`). Test queues email + second portal after an active portal job; neither is `blocked_duplicate` (`369-384`). |
| Clock via `src/lib/mca/submissions/clock.ts` | Pass | Policy uses `nowIso()` (`duplicate-policy.ts:4,39-41,168`). Tests pin time with `setClock` (`247`, `155-157`). Job timestamps in `repository.ts` also use this clock, so windows match fixtures. |
| Same cooldown on UI / API / queue | Pass | `queueDestination` always calls `assertDuplicatePolicy` (`queue.ts:156-162`). HTTP POST maps `privilegedRetry` / `privilegedReason` into the same queue (`queue.ts:271-280`, `[dealId]/route.ts:28-36`). Session POST is `blocked_duplicate`; `intake:write` 403 (`386-402`). |

`blocked_duplicate` / `skipped` do not start a window in `jobBlock` (`duplicate-policy.ts:50-51,79-80`). Exclusive files match the brief; `queue.ts` / `clock.ts` / schema were not required edits.

## Quality

Approved. Minor only:

1. In-flight claims are evaluated **before** privileged retry (`duplicate-policy.ts:203-207`). A claim whose job never persists (crash between `allow()` and `persistNewDestination`) blocks the destination for 24 hours, and a reasoned override cannot clear it. Sequential success after persist is fine because `created_at >= claimedAt` consumes the claim (`103`).
2. `queue.ts:166-171` prefers `preflight_failed` over `blocked_duplicate` when both apply, so a denied destination can still insert an error job. Out of exclusive-file scope; later policy checks still see the stricter window.
3. `addMs` / `nowMs` fall back to wall `Date.now()` when ISO parse fails (`duplicate-policy.ts:34-41`). Happy path and tests use valid `nowIso()` strings.
4. Privileged override is any `deals:write` caller; SelectionPanel confirm does not send the flags (`selection-panel.tsx:132-134`). Matches “admin not required”; override is API-only.
5. Duplicate claims live in `audit_events` (`dupclaim:…` ids) because schema edits were forbidden. Deterministic ids avoid `newId()` collisions.

No Critical or Important defects on the exclusive surface.

## Unverified claims

- **5/5 passed:** the test file defines five `test("MIC-174 …")` cases matching the report/acceptance; this review did not re-execute Postgres.
- **`skipped` / `blocked_duplicate` do not start a window:** implemented in `jobBlock`; no dedicated test that only those rows exist.
- **Background senders:** cooldown is on new `queueSubmissions` jobs, not outbox redelivery of an existing job. Analysis port uses the same queue without privileged flags.
- **Did not edit `queue.ts` / `clock.ts` / `schema.ts`:** current call sites and injectable clock match the handoff; the repo has no git, so in-place rewrites cannot be proven.
