# MIC-174 acceptance — Duplicate blocking and controlled retry (2 min / 24 h)

Executed September 8, 2026. Scope: atomic same-destination cooldown, 2-minute error retry block, 24-hour active-submission block, ISO `eligibleAt`, privileged reasoned retry that retains history, independent destinations, and concurrent submit serialization. Clock is injectable via `setClock` / `nowIso`.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Error retries blocked within 2 minutes | Passed | Email destination fails (Wave 0 transport stub). `assertDuplicatePolicy` at `T0` is `retry_too_soon` with `eligibleAt = T0+2m`. Queue at `T0+2m-1ms` is `blocked_duplicate` and keeps the original failed job |
| Error retry allowed at the 2-minute boundary | Passed | Queue at `T0+2m` creates a new failed job with a different id |
| Active duplicates blocked inside 24 hours | Passed | Portal destination is `pending_portal`. Policy at `T0` and `T0+24h-1ms` is `active_duplicate`. Queue at `T0+2m` is still `blocked_duplicate` |
| Active retry allowed at the 24-hour boundary | Passed | Queue at `T0+24h` creates a new `pending_portal` job (renewal) |
| Concurrent `queueSubmissions` produce one accepted attempt | Passed | Two distinct confirmation keys: one `pending_portal` with one attempt row, one `blocked_duplicate` with zero attempts |
| Privileged retry requires reason and retains history | Passed | `privilegedRetry` without reason stays `active_duplicate`; blank reason queues `blocked_duplicate`; reasoned retry returns `privileged_retry` and a second `pending_portal` while the original id remains |
| Other destinations remain independent | Passed | After a portal block, email and a second portal queue independently (`failed` / `pending_portal`, not `blocked_duplicate`) |
| Direct API matches UI; secrets excluded | Passed | Session POST is `blocked_duplicate` with ISO `eligibleAt` in `reason`; `intake:write` 403; responses omit SMTP password / `credentialCipher` / PDF checksum |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-duplicates.test.ts
```

5/5 passed.

## Behavior

- Policy key is workspace + deal + funder. Advisory transaction lock, job row lock, and a durable `submission.duplicate_claim` cover concurrent UI/API/sender calls through the persist gap.
- Error window: 2 minutes from the failed job's `updated_at`. Active window: 24 hours from the active job's `created_at`. Exact boundary timestamps are eligible (`now >= eligibleAt`).
- `eligibleAt` is ISO-8601 and is copied into `reason` so the existing selection panel can show it.
- Privileged override: both `privilegedRetry` and a trimmed `privilegedReason` are required. Prior jobs are not deleted. Concurrent in-flight claims still serialize to one accepted attempt.
- New confirmation keys are new attempts (subject to cooldown). Same confirmation key remains MIC-166 idempotency.
- Permissions unchanged: `deals:write` confirm, `deals:read` list, `intake:write` 403. Admin is not required.

## UI

`SelectionPanel` (MIC-166) already covers loading, empty funders, validation (no selection), success, and failure. Duplicate denials surface as `blocked_duplicate` with the policy reason (includes `eligibleAt`). This ticket does not remount UI.

## Local vs live gates

Local Postgres fixtures prove cooldown boundaries, privileged retry, cross-funder independence, and concurrent serialization. Email transport is still the Wave 0 `provider_unavailable` stub; portal success is the Wave 0 `pending_portal` stub. Fixture success is not production sending readiness.
