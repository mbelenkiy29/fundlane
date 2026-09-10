# MIC-190 acceptance — Twilio SMS provider adapter

Linear: https://linear.app/michael-belenkiy/issue/MIC-190/twilio-sms-provider-adapter

Synthetic fixtures only. No live SMS and no production rows.

## Linear boxes

| Criterion | Result | Evidence |
| --- | --- | --- |
| A provider sandbox/mock verifies routing, successful send and rejected-number behavior | Pass | Fixture Account SID send of `Exact synthetic Twilio preview` is `accepted` with a stable `SM` identity. Recipient `+12125550000` is `failed` / `twilio_21614` with no phone or body in the error. Injected fetch posts `To`/`From`/`Body`/`StatusCallback` to `https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json`. |
| A retried callback updates the existing message without duplicate delivery records | Pass | `parseStatus` hashes sorted form entries into `eventKey`. Replay of the same delivered payload keeps one row. A later `sent` callback is a second event on the same `MessageSid`. Unsupported `read` is `twilio_status_unsupported`. |
| Realistic synthetic scenario with expected output | Pass | Accepted, rejected-number, timeout, unconfigured, official signature fixture, Advanced Opt-Out `STOP`/`START`, ignored `HELP`. |
| Loading, empty, validation, success and failure; retries preserve identity | Pass | Empty `validate({})` returns Account SID, API key, sending number, and Messaging Service SID field errors. Timeout and unconfigured retries return the first result with no new external id. |
| Direct API requests enforce the same permissions as the UI. Logs exclude secrets | Pass | Adapter has no HTTP surface; M5 account mutation remains admin-only. Delivery results omit API key secret, auth token, and recipient/body on 21614. |

## Expected synthetic output

- Missing fields: `{ ok: false, fields: { accountSid, apiKeySid, apiKeySecret, sendingNumber, messagingServiceSid } }`
- Accepted send: `{ state: "accepted", providerStatus: "queued", externalId: "SM…" }`
- Rejected number: `{ state: "failed", errorCode: "twilio_21614" }`
- Timeout: `{ state: "unknown", errorCode: "provider_outcome_unknown", externalId: undefined }`
- Unconfigured: `{ state: "failed", errorCode: "twilio_unconfigured" }`
- Delivered callback replay: same `eventKey`, one stored message row
- Capabilities: `{ send: true, statusCallbacks: true, inbound: true, optOut: true }`

## Commands

```bash
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/sms-adapters/twilio.test.ts tests/milestone05-sms.test.ts
```

8 adapter tests and 9 M5 SMS tests passed.

## Remaining gates

Live Twilio account and handset delivery. Do not treat fixture acceptance as production integration readiness.

## Handoff

Conductor imports `twilioSmsAdapter` in `registry.ts`, replacing the inline legacy adapter.
