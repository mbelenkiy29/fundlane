# MIC-178 report — Manual portal tasks and custom webhook submission

**Status:** DONE locally with synthetic fixtures. Live funder portals and live webhook endpoints remain an external gate.

## Contract

`createPortalTask` records a ledger job as `pending_portal`. Opening the funder URL (`POST /api/mca/submissions/portal/[dealId]` `action: "open"`) audits the open, may update the pending reason, and never transitions to `sent`. Completion requires `deals:write` (`action: "complete"`) with an optional external reference. Replay of complete on an already-sent job returns the same job id and keeps the first reference.

Custom webhooks POST a JSON package (deal/funder/job/document checksums, no file bytes) to the funder route destination. The `Authorization` header is derived from destination userinfo (`Bearer` token or HTTP Basic) or a `token` / `access_token` query parameter. Credentials are stripped from the outbound URL. HTTP 500 (and other non-2xx) leave the job `failed`. 2xx is delivery `sent` only — `responseSync` is always `false`; webhook bodies are not parsed into offers or status.

Shared ledger: `mca_submission_jobs` / `mca_submission_attempts` / `deal_submissions` cache. Portal complete updates the existing attempt to `sent`. Webhook attempts store correlation id and HTTP error without secrets.

Permissions: `deals:read` lists the board. `deals:write` opens or completes. `intake:write` is 403. Cross-workspace deal ids are 404.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-portal.test.ts
```

3/3 passed.

Covered: portal open ≠ sent; confirm completion with optional external ref and idempotent replay; mixed portal complete vs webhook HTTP 500 failed; auth header from destination userinfo; no webhook token in JSON/logs; no `deal_offers` from webhook; intake and `deals:read` POST 403; `deals:read` GET and `deals:write` POST; forged workspace 404.

## Files

- `src/lib/mca/submissions/portal.ts`
- `src/lib/mca/submissions/webhook.ts`
- `src/app/api/mca/submissions/portal/[dealId]/route.ts`
- `src/components/mca/submissions/portal-panel.tsx`
- `tests/submissions-portal.test.ts`
- `docs/milestone-04/MIC-178-acceptance.md`
- `docs/milestone-04/MIC-178-report.md`

Did not edit `queue.ts`, `outbox.ts`, `repository.ts`, `schema.ts`, or `deals-workspace.tsx`.

## Remaining gates

Live funder portal access and live custom-webhook endpoints. Fixture HTTP 500 / pending_portal is not production delivery readiness. Custom webhooks do not poll or ingest provider callbacks (MIC-113).

## Handoff

Mount `PortalPanel` on the deal workspace next to `SelectionPanel`.
