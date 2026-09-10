# MIC-158 report — Outbound workflow webhooks and assignment notifications

**Status:** DONE locally with synthetic fixtures. Live HTTPS destinations remain an external gate.

## Contract

Workspace admins configure endpoints on `mca_workflow_webhook_endpoints` (HTTPS URL, selected events, encrypted signing secret, optional originator/closer flags). `GET`/`POST`/`PATCH`/`DELETE /api/mca/comms/webhooks` and test/replay routes are **session-only admin**. API keys, including `deals:read` / `deals:write` / `intake:write`, are `403 session_required`. Reps are `403 permission_denied`.

`publishWorkflowWebhook` writes versioned spec `1` envelopes for `offer.created`, `deal.transitioned`, `deal.assigned`, and `submission.created` with a stable `event_id`. Matching enabled endpoints receive a transactional outbox row on `mca_workflow_webhook_outbox` unique `(workspace_id, endpoint_id, event_id)`. Re-publish of the same id is a no-op. Payloads are minimum deal/offer/assignment/submission fields; commissions, EIN, credentials, and document bytes are omitted.

The scheduler handler registers with `registerCommsJob("webhook_outbox", ...)` from `webhooks.ts`. `processWebhookOutbox` (and `POST /api/mca/comms/jobs/run` with `kinds: ["webhook_outbox"]`) HMAC-signs `timestamp.body` (`x-mca-webhook-signature: v1=…`), POSTs the stored payload, and records `mca_workflow_webhook_deliveries` per attempt. Automatic retries stop at 5. Manual replay reuses the same `event_id` and payload. Opening the console or a test POST does not mark workflow outbox rows delivered.

Destinations reject localhost, private IPs, credentials, non-HTTPS, and nonstandard ports. The only non-HTTPS exception is `mca://webhook/test`. Delivery injects `setWorkflowWebhookFetchForTests`; tests never call live `fetch`. Assignment notifications include only active, in-workspace, deal-visible originators/closers when those flags are on.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-webhooks.test.ts
```

3/3 passed.

Covered: replay keeps `event_id` and HMAC; unique outbox; bounded retries then manual replay; SSRF rejects; GET/test do not mark delivered; assignment recipients omit deactivated, other-workspace, and unconfigured closer/originator rows; four envelope types; session admin vs API-key 403; UI loading/empty/validation/success/failure copy; secrets omitted after create.

## Files

- `src/lib/mca/comms/webhooks.ts`
- `src/app/api/mca/comms/webhooks/route.ts`
- `src/app/api/mca/comms/webhooks/[id]/route.ts`
- `src/app/api/mca/comms/webhooks/[id]/test/route.ts`
- `src/app/api/mca/comms/webhooks/outbox/[id]/replay/route.ts`
- `src/app/api/mca/comms/webhooks/events/route.ts`
- `src/components/mca/comms/webhook-console.tsx`
- `tests/milestone06-webhooks.test.ts`
- `docs/milestone-06/MIC-158-report.md`
- `docs/milestone-06/MIC-158-acceptance.md`

Did not edit `comms/jobs.ts` except calling `registerCommsJob` from `webhooks.ts`. Did not mount the console or import `webhooks.ts` from the jobs run route.

## Remaining gates

Reachable customer HTTPS endpoints and a stored signing secret. Injected fetch and `mca://webhook/test` are not production delivery readiness. Deal/offer/submission writers do not yet call `publishWorkflowWebhook` (conductor mount).

## Handoff

Mount `WebhookConsole` on Settings → Connections. Import `src/lib/mca/comms/webhooks.ts` from the conductor-owned comms jobs run route so `registerCommsJob("webhook_outbox", ...)` is loaded in process. Call `publishWorkflowWebhook` from deal assignment/transition, offer, and submission writers when those shared files are open.
