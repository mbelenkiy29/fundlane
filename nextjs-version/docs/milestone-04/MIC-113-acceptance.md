# MIC-113 acceptance — Status polling, webhook ingestion, offer reconciliation

Executed September 8, 2026. Scope: capability-gated API status poll and manual refresh, authenticated inbound adapter webhooks, versioned status mapping, `deal_offers` persistence only when financial terms exist, and replay / out-of-order guards so funded outcomes do not regress. Offer comparison UI remains M5.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Replay webhook does not duplicate offers | Passed | `tests/submissions-status.test.ts` — same `eventId` twice keeps one `deal_offers` row and the original amount; `duplicate: true` returns the first offer id |
| Out-of-order pending does not regress funded | Passed | Funded webhook with terms → `accepted` / amount 25000; later pending with different terms is `ignoredReason: funded_terminal`; still one offer, `raw_status` stays `funded`, cache `approved` |
| Unknown status remains visible with original value | Passed | `CREDIT_COMMITTEE_HOLD` webhook: `unknown: true`, raw preserved, no offer; poll of `AWAITING_BANK_VERIFICATION` updates the visible cache without inventing terms |
| Submit-only adapter poll 409 | Passed | Manual refresh of a sent submit-only job returns `409 capability_unsupported` |
| Empty / validation / success / failure usable | Passed | GET board `state: empty` with no API jobs; missing `dealId` 422; invalid JSON 400; webhook missing secret 401; successful refresh/webhook JSON |
| Direct API matches UI permissions; secrets omitted | Passed | `deals:read` GET 200; `deals:read` and `intake:write` POST 403; cross-workspace 404; HTTP bodies omit API / webhook secrets and `credentialCipher` |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/submissions-status.test.ts
```

4/4 passed.

## Behavior

- Poll and manual refresh require `capabilities.statusPoll` and `getStatus`. Submit-only 409s refresh. Scheduled/deal batch poll skips incapable adapters.
- Webhooks: `x-mca-webhook-secret` (or HMAC `x-mca-signature`) must match the environment credential. Dedupe key is `webhook:<slug>:<eventId>`. Raw status is stored separately from the mapped value (`STATUS_MAPPING_VERSION = 1`).
- `deal_offers` insert/update only when `amount` / `rate` / `term` / `commission` is present. Unknown statuses stay visible (`unknown: true` plus original raw). Funded/`accepted` does not move back to pending.
- Reads: `deals:read`. Writes (refresh): `deals:write` with `assertTrustedMutation`. Inbound webhooks are not session-authenticated. `cache-control: no-store`, `runtime = "nodejs"`.

## UI

No exclusive UI file. GET `/api/mca/submissions/webhooks/refresh?dealId=` returns `empty` or `ready` with jobs/offers; POST refresh returns `success` or HTTP error (validation, 409, 401, 403, 404). Conductor may mount a refresh control on the deal workspace.

## Local vs live gates

Local Postgres fixtures prove replay, out-of-order funded, unknown preservation, capability 409s, and ACL. Live funder status endpoints and webhook signatures are not production-verified. Mock/fixture success is not production integration readiness.
