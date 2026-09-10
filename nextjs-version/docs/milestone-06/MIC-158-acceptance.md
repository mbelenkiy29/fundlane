# MIC-158 acceptance — Outbound workflow webhooks and assignment notifications

Executed September 8, 2026. Scope: endpoint/event selection, optional originator/closer notifications, versioned envelopes, transactional outbox, HMAC, bounded retries, replay with stable `event_id`, SSRF-safe destinations. Live customer webhooks are out of scope.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| A replay preserves event identity so receivers can deduplicate | Passed | `tests/milestone06-webhooks.test.ts` — second `publishWorkflowWebhook` with the same `event_id` inserts no outbox row; failed automatic attempts then `replayWebhookOutbox` POST the stored payload with the original `event_id` and HMAC over `timestamp.body` |
| Assigning a rep notifies only authorized configured recipients | Passed | `deal.assigned` with notify-originator-only includes the active assigned originator and omits the closer, a deactivated originator, and a foreign-workspace membership; disabled and non-subscribed endpoints are not enqueued |
| Synthetic scenario: four envelopes, outbox, SSRF, retries | Passed | Offer / transition / assignment / submission spec `1` envelopes; unique `(workspace, endpoint, event_id)`; localhost / private IP / HTTP rejected; `mca://webhook/test` allowed; five failed attempts mark `failed`; job replay of a delivered row is a no-op |
| Loading / empty / validation / success / failure UI; retries preserve identity | Passed | `WebhookConsole` copy for loading, empty, HTTPS validation, missing events, saved, delivered, `role="alert"`; GET console and test POST leave workflow outbox `pending`; retry/replay keep `event_id` |
| Direct API permissions match UI; secrets excluded | Passed | Session admin GET/POST 200/201; rep 403; `deals:read`, `deals:write`, and `intake:write` keys 403; other-workspace session 404; signing secret returned once on create/rotate and omitted from later JSON, deliveries, and HMAC headers |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-webhooks.test.ts
```

3/3 passed.

## Behavior

- Events: `offer.created`, `deal.transitioned`, `deal.assigned`, `submission.created`. Envelope `spec_version` is `"1"`.
- Outbox states `pending` / `delivered` / `failed`. Automatic delivery stops at 5 attempts. Manual replay increments attempt and keeps `event_id`.
- Signing: `x-mca-webhook-signature: v1=<hex>` over `{unix_timestamp}.{body}`. Secret stored with `encryptSensitive`.
- Destinations must be HTTPS without credentials or a nonstandard port, and must not be localhost/private. Test hook `mca://webhook/test` is the non-HTTPS exception.
- Originator/closer notification lists are recomputed at enqueue from active workspace members who can access the deal and match the endpoint flags.
- `runtime = "nodejs"`, `cache-control: no-store`, `assertTrustedMutation` on writes. Injected fetch in tests; `NODE_ENV=test` without an override does not call live `fetch`.

## UI

`WebhookConsole` covers loading, empty (no endpoints), validation (HTTPS URL / at least one event), success (saved / delivered / replay), and failure (`role="alert"`). Test delivery copy states it does not mark workflow events delivered. Conductor mounts it on Settings → Connections.

## Local vs live gates

Local Postgres fixtures prove outbox identity, HMAC, SSRF, recipient filtering, permissions, and injected fetch. There is no live customer webhook. Fixture success is not production delivery readiness.
