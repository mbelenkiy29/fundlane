# MIC-113 report — Status polling, webhook ingestion, offer reconciliation

**Status:** DONE locally with synthetic fixtures. Live funder status APIs and signed webhooks remain an external gate.

## Contract

`refreshSubmissionStatus` and `pollActiveSubmissions` call `getStatusViaAdapter` only when `capabilities.statusPoll` is true and `getStatus` exists. Manual refresh uses the same gate and returns `409 capability_unsupported` for submit-only adapters. Batch poll skips incapable destinations instead of failing the workspace run.

Inbound `POST /api/mca/submissions/webhooks/[slug]` verifies a shared secret (`x-mca-webhook-secret`, `x-webhook-secret`, or non-`mca_` bearer) or HMAC `x-mca-signature` against the workspace credential `webhookSecret`. Missing/wrong authenticity is `401 webhook_unauthenticated`. Events are deduplicated by provider `eventId` / reference via unique `(job_id, attempt_key)` receipts. `parseWebhookViaAdapter` maps the payload; raw status is retained.

Statuses map through `STATUS_MAPPING_VERSION = 1`. Unknown values stay `unknown: true` with the original raw string and remain visible on `deal_submissions.status` when they are the current in-flight value. `deal_offers` rows are created or updated only when financial terms (`amount`, `rate`, `term`, or `commission`) are present. Approval without terms does not invent amounts.

Out-of-order and replayed events do not duplicate API offers (one row per submission, `source = api`). A `funded` / `accepted` offer is terminal: later pending events are ignored (`ignoredReason: funded_terminal`) and do not change amount or status.

Manual refresh is `deals:write`. Status board GET is `deals:read`. `intake:write` is 403. Webhook ingest is secret-authenticated, not a user session. JSON and audit metadata omit secrets.

Offers comparison UI is M5 — this ticket persists rows only.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-status.test.ts
```

4/4 passed.

Covered: webhook replay keeps one offer id and original terms; funded then pending does not regress or duplicate; unknown raw status is preserved and creates no offer; submit-only poll 409; empty board; validation 422 / invalid JSON 400; `intake:write` and `deals:read` cannot refresh; `deals:read` GET; cross-workspace 404; webhook without secret 401; responses omit secrets.

## Files

- `src/lib/mca/submissions/poll.ts`
- `src/lib/mca/submissions/webhooks.ts`
- `src/lib/mca/submissions/reconciliation.ts`
- `src/app/api/mca/submissions/webhooks/[slug]/route.ts`
- `src/app/api/mca/submissions/webhooks/refresh/route.ts`
- `tests/submissions-status.test.ts`
- `docs/milestone-04/MIC-113-report.md`
- `docs/milestone-04/MIC-113-acceptance.md`

Did not edit `schema.ts`, drizzle, `registry.ts`, adapter framework/credentials, `repository.ts`, or deal UI.

## Remaining gates

Commercial funder sandbox credentials, live status poll HTTP, and live signed webhooks. Fixture success is not production integration readiness.

## Handoff

Mount a deal-level status refresh control on `GET`/`POST /api/mca/submissions/webhooks/refresh` (`deals:read` board, `deals:write` refresh). Schedule `pollActiveSubmissions` for sent API jobs. Adapter tickets should return honest `statusPoll` / `webhooks` flags, raw provider status, `eventId`, and terms only when the provider supplied them.
