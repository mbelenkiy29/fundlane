# MIC-166 brief — Multi-funder selection, preflight and independent jobs

Read this first. Exact values are verbatim.

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-166
**Depends on:** MIC-121 (senders), MIC-192, MIC-169, MIC-91 (done)

## Exclusive files

- `src/lib/mca/submissions/jobs.ts`
- `src/lib/mca/submissions/preflight.ts`
- `src/lib/mca/submissions/outbox.ts`
- `src/lib/mca/submissions/queue.ts`
- `src/lib/mca/submissions/repository.ts`
- `src/lib/mca/underwriting/submission-port.ts` (replace the fail-closed stub)
- `src/app/api/mca/submissions/**` except `portal/**`, `stamps/**`, `watermarks/**`, `email/**`, `webhooks/**`, `replies/**`, `extract/**`, `compress/**`
- `src/components/mca/submissions/selection-panel.tsx`
- `tests/submissions-core.test.ts`
- `docs/milestone-04/MIC-166-report.md`
- `docs/milestone-04/MIC-166-acceptance.md`

Do not edit `duplicate-policy.ts`, `stamps.ts`, `schema.ts`, `deals-workspace.tsx`. No git. No subagents. Do not mark Linear Done.

## Frozen behavior

- `queueSubmissions` in `submission-port.ts` must call the real queue and return `{ ok: true, jobs }` (extend the return type; analysis remount is conductor-owned).
- One job per selected funder. One rejected destination does not stop others.
- Freeze deal version + document checksums at confirmation.
- Unique `(workspace_id, confirmation_key, funder_id)` — replay creates no second external request.
- Transactional outbox row per job (`mca_submission_outbox`).
- Call `assertDuplicatePolicy` from `./duplicate-policy` (Wave 0 allows all; MIC-174 will replace).
- Call `prepareOutgoingPackage` then `deliverSubmission` from ports.
- Use funder directory routes (`email|api|manual_portal|custom_webhook`). Missing active route → `preflight_failed` for that destination only.
- `deal_submissions` display cache: set `funder_name`, `funder_id`, `job_id`, `route_kind`, `status`.
- Permissions: `deals:write` to confirm; `deals:read` to list. Admin not required. `intake:write` 403.
- Export `queueSubmissions` compatible with `src/lib/mca/underwriting/analysis.ts` current call shape (`actor, dealId, funderIds, analysisRunId`). Generate `confirmationKey` from analysisRunId when present, else newId.

## Acceptance

- One rejected destination does not stop valid destinations.
- Repeated confirmation creates no duplicate external request (same confirmationKey).
- Loading/empty/validation/success/failure UI states on SelectionPanel.
- Direct API enforces same permissions. Logs exclude secrets.

## Tests

`tests/submissions-core.test.ts` with createPostgresTestDatabase. Seed deal, documents, two funders (one email route, one broken/missing route). Confirm both; assert one sent/queued/failed independently; replay same confirmationKey; forged workspace 404; intake key 403.

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-core.test.ts
```
