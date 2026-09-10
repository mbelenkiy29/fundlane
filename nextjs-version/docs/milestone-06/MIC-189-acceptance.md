# MIC-189 acceptance — OpenPhone SMS provider adapter

Linear: https://linear.app/michael-belenkiy/issue/MIC-189/openphone-sms-provider-adapter

Synthetic fixtures only. No live SMS and no production rows.

## Linear boxes

| Criterion | Result | Evidence |
| --- | --- | --- |
| A provider sandbox/mock verifies routing, successful send and rejected-number behavior | Pass | Fixture API key send of `Exact synthetic OpenPhone preview` is `accepted` with a stable `AC` identity. Recipient `+12125550000` is `failed` / `openphone_0200400` with no phone or body in the error. Injected fetch posts `{ content, from, to, userId }` to `https://api.quo.com/v1/messages` with raw `Authorization` (no Bearer). |
| A retried callback updates the existing message without duplicate delivery records | Pass | `parseStatus` hashes event id, type, message id, and status into `eventKey`. Replay of the same `message.delivered` payload keeps one row. A later delivered event with a new `EV` id is a second event on the same `AC` message. `message.received` is `openphone_status_unsupported`. |
| Realistic synthetic scenario with expected output | Pass | Accepted, rejected-number, timeout, unconfigured, documented HMAC signature fixture, inbound STOP/START, ignored HELP. |
| Loading, empty, validation, success and failure; retries preserve identity | Pass | Empty `validate({})` returns API key, user, and sending number field errors. Timeout and unconfigured retries return the first result with no new external id. |
| Direct API requests enforce the same permissions as the UI. Logs exclude secrets | Pass | Adapter has no HTTP surface; M5 account mutation remains admin-only. Delivery results omit API key secret and recipient/body on 400. |

## Expected synthetic output

- Missing fields: `{ ok: false, fields: { apiKey, user, sendingNumber } }`
- Accepted send: `{ state: "accepted", providerStatus: "queued", externalId: "AC…" }`
- Rejected number: `{ state: "failed", errorCode: "openphone_0200400" }`
- Timeout: `{ state: "unknown", errorCode: "provider_outcome_unknown", externalId: undefined }`
- Unconfigured: `{ state: "failed", errorCode: "openphone_unconfigured" }`
- Delivered callback replay: same `eventKey`, one stored message row
- Capabilities: `{ send: true, statusCallbacks: true, inbound: true, optOut: true }`

## Commands

```bash
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/sms-adapters/openphone.test.ts
```

8 adapter tests passed.

## Remaining gates

Live OpenPhone/Quo account, US carrier registration, prepaid API credits, and handset delivery. Do not treat fixture acceptance as production integration readiness.

Public v1 does not publish a dedicated invalid-destination code; rejected-number uses the documented 400 invalid-parameters envelope (`0200400`). `statusCallbackUrl` is unused on send because delivery callbacks are workspace webhooks, not a per-message field.

## Handoff

Conductor imports `openphoneSmsAdapter` in `registry.ts`.
