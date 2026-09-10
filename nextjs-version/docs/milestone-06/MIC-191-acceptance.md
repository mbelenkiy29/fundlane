# MIC-191 acceptance — GoHighLevel SMS provider adapter

Linear: https://linear.app/michael-belenkiy/issue/MIC-191/gohighlevel-sms-provider-adapter

Executed against public HighLevel docs (Private Integrations, Conversations send, duplicate/upsert contact, InboundMessage, OutboundMessage, Webhook Integration Guide). Scope: `SmsAdapter` for slug `gohighlevel` with Private Integration Token + Location ID, synthetic fixtures, honest capability flags. Live GoHighLevel send is out of scope. Conductor registers the adapter after review.

## Linear boxes

| Criterion | Result | Evidence |
| --- | --- | --- |
| A provider sandbox/mock verifies routing, successful send and rejected-number behavior | Pass | Fixture PIT send of `Exact synthetic GoHighLevel preview` is `accepted` with a stable 20-character `messageId` and `providerStatus: pending`. Recipient `+12125550000` is `failed` / `gohighlevel_invalid_phone` with no phone or body in the error. Injected fetch `GET`s `/contacts/search/duplicate` then `POST`s `{ type: "SMS", contactId, message, toNumber, fromNumber }` to `https://services.leadconnectorhq.com/conversations/messages` with `Authorization: Bearer` and `Version: 2021-07-28`. Missing contact `POST`s `/contacts/upsert` `{ locationId, phone }` before send. |
| A retried callback updates the existing message without duplicate delivery records | Pass | `parseStatus` hashes sorted `OutboundMessage` keys into `eventKey`. Replay of the same delivered payload keeps one row. A later `sent` callback is a second event on the same `messageId`. Unsupported `queued` is `gohighlevel_status_unsupported`. |
| Realistic synthetic scenario with expected output | Pass | Accepted, rejected-number, timeout, unconfigured, expired PIT, upsert-on-missing-contact, inbound `STOP`/`START`, ignored CALL/outbound, Ed25519 signature helper with a local keypair. |
| Loading, empty, validation, success and failure; retries preserve identity | Pass | Empty `validate({})` returns Private Integration Token and Location ID field errors. Timeout and unconfigured retries return the first result with no new external id. |
| Direct API requests enforce the same permissions as the UI. Logs exclude secrets | Pass | Adapter has no HTTP surface; M5 account mutation remains admin-only. Delivery results omit the PIT, expired token, recipient, and body on invalid-phone. |

## Expected synthetic output

- Missing fields: `{ ok: false, fields: { privateIntegrationToken, locationId } }`
- Accepted send: `{ state: "accepted", providerStatus: "pending", externalId: "…" }`
- Rejected number: `{ state: "failed", errorCode: "gohighlevel_invalid_phone" }`
- Timeout: `{ state: "unknown", errorCode: "provider_outcome_unknown", externalId: undefined }`
- Unconfigured: `{ state: "failed", errorCode: "gohighlevel_unconfigured" }`
- Expired PIT (injected fetch): `{ state: "failed", errorCode: "gohighlevel_unauthorized" }`
- Delivered callback replay: same `eventKey`, one stored message row
- Capabilities: `{ send: true, statusCallbacks: true, inbound: true, optOut: true }`

## Commands

```bash
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/sms-adapters/gohighlevel.test.ts
```

8/8 passed.

## Behavior

- Credentials: `privateIntegrationToken` + `locationId` (Linear: Private Integration Token, Location ID).
- `testConnection` is `ok` only when `account.providerConfigured`.
- Default send is fixture-backed for the synthetic PIT (`fixture://gohighlevel/conversations/messages`). No live `services.leadconnectorhq.com` call from this ticket.
- Phone `senderIdentity` maps `fromNumber`. Non-E.164 sender omits `fromNumber` so the location default number is used.
- `statusCallbackUrl` is unused on send. Status/inbound arrive as location or marketplace webhooks, not per-message callback URLs.

## Local vs live gates

Local fixtures prove mapping, idempotency, rejected-number, timeout identity, OutboundMessage replay, inbound keywords, upsert-on-missing-contact, and secret redaction. There is no GoHighLevel sandbox session. Fixture success is not production sending readiness.

## Handoff

Conductor imports `gohighlevelSmsAdapter` in `src/lib/mca/sms/adapters/registry.ts` after review.
