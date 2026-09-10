# MIC-178 acceptance — Manual portal tasks and custom webhook submission

Executed September 8, 2026. Scope: tracked manual funder portal tasks (URL, operator, package download, completion/reference) and custom webhook delivery (schema preview, destination auth header, attempt log) on the shared submission ledger. Opening a portal does not mark submitted. Webhook failures stay `failed` and are not portal completions. Response-sync is not claimed.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Opening a portal URL does not mark submitted | Passed | `tests/submissions-portal.test.ts` — queued job is `pending_portal`; `action: "open"` returns the URL and leaves job/attempt not `sent` |
| Confirm completion with optional external ref | Passed | `deals:write` `action: "complete"` with `PORTAL-REF-17` → job and attempt `sent`; replay keeps the same job id and first reference |
| Webhook HTTP 500 stays failed, distinct from portal complete | Passed | Mixed queue: portal `pending_portal` then `sent`; webhook `failed` with `provider_error` / HTTP 500; `deal_offers` stays 0; board `responseSync: false` |
| Intake key cannot confirm | Passed | `intake:write` POST 403 (`scope_required` or `permission_denied`); job remains `pending_portal` |
| Direct API matches UI; secrets excluded | Passed | `deals:read` GET 200; `deals:read` POST 403; `deals:write` POST 200; forged workspace 404; responses omit webhook token / `credentialCipher` |
| Loading / empty / validation / success / failure UI | Passed | `PortalPanel` loading copy, empty board, invalid action 422, success status, request-error alert; webhook delivery log and schema preview |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-portal.test.ts
```

3/3 passed.

## Behavior

- Portal transport (`createPortalTask`) writes `pending_portal` on the shared job ledger. Opening records `submission.portal_opened` and does not change state to `sent`.
- Completion is `deals:write` only, optional `externalRef` (max 200). Already-sent completes are idempotent. Display cache becomes `sent`.
- Custom webhook POSTs JSON checksums to the HTTPS destination. `Authorization` comes from route destination userinfo or `token` query. Private-network destinations are rejected. Non-2xx stays `failed`.
- Board GET includes portal URL, assigned operator (`created_by_user_id`), frozen package documents, webhook schema preview, and attempt logs. `x-mca-response-sync: false`.
- Reads: `deals:read`. Writes: `deals:write` with `assertTrustedMutation`. `intake:write` 403. Cross-workspace 404. `cache-control: no-store`, `runtime = "nodejs"`.

## UI

`PortalPanel` covers loading, empty (no portal/webhook jobs), validation (confirm/open errors), success (pending vs completed), and failure (request error plus failed webhook log). Package download uses existing document download tokens. Conductor mounts the panel on the deal workspace.

## Local vs live gates

Local Postgres fixtures prove portal open ≠ sent, confirm completion, webhook 500 ≠ portal complete, and ACL. Live ISO portals and live webhook endpoints are not exercised. Fixture success is not production sending readiness. Custom webhooks do not implement MIC-113 status polling or inbound funder webhooks.
