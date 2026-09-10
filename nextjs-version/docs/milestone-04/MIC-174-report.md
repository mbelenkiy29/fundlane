# MIC-174 report — Duplicate blocking and controlled retry (2 min / 24 h)

**Status:** DONE locally with synthetic fixtures. `assertDuplicatePolicy` is already called from `queue.ts` (MIC-166); this ticket replaces the Wave 0 allow-all stub.

## Contract

Same workspace/deal/funder cooldown is atomic across UI, API, and background senders. The policy runs inside a transaction with `pg_advisory_xact_lock` plus `SELECT … FOR UPDATE` on existing jobs, and writes a durable destination claim so concurrent `queueSubmissions` cannot both accept during the persist gap.

- Failed / preflight-failed jobs: block retries until `updated_at + 2 minutes` (`retry_too_soon`).
- Active jobs (`queued`, `sending`, `sent`, `pending_portal`): block until `created_at + 24 hours` (`active_duplicate`).
- `blocked_duplicate` and `skipped` do not start a new window.
- Block responses include ISO `eligibleAt` and a reason that repeats that timestamp.
- `privilegedRetry === true` with a non-empty `privilegedReason` allows a new job (`privileged_retry`) and keeps prior rows. Either flag alone does not override.
- Other funders are independent.
- Clock is `src/lib/mca/submissions/clock.ts` (`nowIso`, `setClock`).

Queue still persists a `blocked_duplicate` job when the policy denies, so history is retained. Privileged retry never deletes prior jobs.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-duplicates.test.ts
```

5/5 passed.

Covered: 2-minute error boundary (`T+2min-1` blocked, `T+2min` allowed); 24-hour active boundary (`T+2min` and `T+24h-1` blocked, `T+24h` allowed); concurrent `queueSubmissions` with distinct confirmation keys (one `pending_portal` attempt, one `blocked_duplicate`); privileged retry with reason (prior job kept) and missing/blank reason still blocked; cross-funder allowed; HTTP confirm uses the same policy; `intake:write` 403; responses omit SMTP secrets and document checksums.

## Files

- `src/lib/mca/submissions/duplicate-policy.ts`
- `tests/submissions-duplicates.test.ts`
- `docs/milestone-04/MIC-174-report.md`
- `docs/milestone-04/MIC-174-acceptance.md`

Did not edit `queue.ts`, `schema.ts`, `clock.ts`, or the selection UI.

## Remaining gates

None for this ticket. Live email/API delivery remains later tickets. Fixture success is not production sending readiness.

## Handoff

No shared mount. `queue.ts` already calls `assertDuplicatePolicy` and stores `blocked_duplicate` with `duplicate.reason`. Selection panel already renders that reason.
