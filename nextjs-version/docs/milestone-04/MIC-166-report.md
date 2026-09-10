# MIC-166 report — Multi-funder selection, preflight and independent jobs

**Status:** DONE locally with synthetic fixtures. Email transport remains the Wave 0 `provider_unavailable` stub (MIC-153).

## Contract

`queueSubmissions` in `src/lib/mca/underwriting/submission-port.ts` calls the real queue and returns `{ ok: true, jobs }`. When `analysisRunId` is present it is used as `confirmationKey`; otherwise a new id is generated.

One job per selected funder. Unique `(workspace_id, confirmation_key, funder_id)`. Replay of the same confirmation key returns the existing job and does not insert a second attempt or make a second delivery call. Each destination is isolated: a missing route or unusable sender is `preflight_failed` for that funder only.

Confirmation freezes deal version and document checksums. A transactional outbox row is written per job (`mca_submission_outbox`). `assertDuplicatePolicy` is called (Wave 0 allows all). Passing preflight calls `prepareOutgoingPackage` then `deliverSubmission`. Email preflight uses `assertSenderUsable`; missing/unusable submission-purpose senders fail that destination only.

`deal_submissions` display cache stores `funder_name`, `funder_id`, `job_id`, `route_kind`, and a mapped `status`.

Permissions: `deals:write` to confirm, `deals:read` to list. Admin is not required. `intake:write` is 403. Direct API matches the UI. Logs and JSON omit sender secrets.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-core.test.ts
```

4/4 passed.

Covered: independent email vs missing-route destinations; frozen deal version and checksums; outbox + display cache; idempotent confirmationKey (service and HTTP); email without a usable sender; forged workspace 404; intake and `deals:read` POST 403; `deals:read` GET and `deals:write` POST; no SMTP password / `credentialCipher` in responses.

## Files

- `src/lib/mca/submissions/jobs.ts`
- `src/lib/mca/submissions/preflight.ts`
- `src/lib/mca/submissions/outbox.ts`
- `src/lib/mca/submissions/queue.ts`
- `src/lib/mca/submissions/repository.ts`
- `src/lib/mca/underwriting/submission-port.ts`
- `src/app/api/mca/submissions/[dealId]/route.ts`
- `src/components/mca/submissions/selection-panel.tsx`
- `tests/submissions-core.test.ts`
- `docs/milestone-04/MIC-166-acceptance.md`
- `docs/milestone-04/MIC-166-report.md`

Did not edit `duplicate-policy.ts`, `stamps.ts`, `schema.ts`, `analysis.ts`, or `deals-workspace.tsx`.

## Remaining gates

None for this ticket. Live email delivery is MIC-153. Mock/stub delivery is not production sending readiness.

## Handoff

Mount `SelectionPanel` on the deal workspace. `analysis.ts` still maps automatic send to `submission_unavailable` until the conductor remounts the success path onto `{ ok: true, jobs }`.
