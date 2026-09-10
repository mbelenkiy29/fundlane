# MIC-188 acceptance — TextUs SMS provider adapter

Linear: https://linear.app/michael-belenkiy/issue/MIC-188/textus-sms-provider-adapter

Executed against public TextUs Next API docs (https://apidocs.next.textus.com/). Synthetic fixtures only. No live SMS and no production rows. Conductor registers the adapter after review.

## Linear boxes

| Criterion | Result | Evidence |
| --- | --- | --- |
| A provider sandbox/mock verifies routing, successful send and rejected-number behavior | Pass | Fixture API key send of `Exact synthetic TextUs preview` is `accepted` with a stable `/messages/…` identity. Recipient `+15550000999` is `failed` / `textus_invalid_number` with no phone or body in the error. Injected fetch posts `email`/`to`/`body`/`from` to `https://next.textus.com/messages` with `application/vnd.textus+jsonld` and `Authorization: Bearer`. |
| A retried callback updates the existing message without duplicate delivery records | Pass | `parseStatus` uses webhook delivery `id` as `eventKey`. Replay of the same `message.delivered` payload keeps one row. A later `message.failed` is a second event on the same Message `id`. `message.received` is `textus_status_unsupported`. |
| Realistic synthetic scenario with expected output | Pass | Accepted, rejected-number, timeout, unconfigured, expired key, documented HMAC-SHA256 signature, inbound `message.received`, `contact.opted_out` / `contact.opted_in`, inbound `STOP`. |
| Loading, empty, validation, success and failure; retries preserve identity | Pass | Empty `validate({})` returns account email and API key field errors. Invalid email rejected. `email`/`token` aliases accepted. Timeout and unconfigured retries return the first result with no new external id. |
| Direct API requests enforce the same permissions as the UI. Logs exclude secrets | Pass | Adapter has no HTTP surface; M5 account mutation remains admin-only. Delivery results omit API key, webhook secret, recipient, and body on rejected-number. |

## Expected synthetic output

- Missing fields: `{ ok: false, fields: { accountEmail, apiKey } }`
- Accepted send: `{ state: "accepted", providerStatus: "queued", externalId: "/messages/…" }`
- Rejected number: `{ state: "failed", errorCode: "textus_invalid_number" }`
- Timeout: `{ state: "unknown", errorCode: "provider_outcome_unknown", externalId: undefined }`
- Unconfigured: `{ state: "failed", errorCode: "textus_unconfigured" }`
- Delivered callback replay: same `eventKey`, one stored message row
- Capabilities: `{ send: true, statusCallbacks: true, inbound: true, optOut: true }`

## Commands

```bash
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/sms-adapters/textus.test.ts
```

8 adapter tests passed.

## Behavior

- Credentials: `accountEmail` + `apiKey` (Linear: account email, API key).
- `testConnection` is `ok` only when `account.providerConfigured`.
- Default send is fixture-backed for the synthetic API key. No live `next.textus.com` call from this ticket.
- E.164 `senderIdentity` maps documented `from`. Non-phone sender omits `from` and sends as the user `email`.
- `statusCallbackUrl` is unused: TextUs webhooks are account integrations (`POST /{account}/integrations`), not a send-body field.

## Local vs live gates

Local fixtures prove mapping, idempotency, rejected-number, timeout identity, delivery-callback dedupe, inbound/opt-out, signature algorithm, and secret redaction. There is no TextUs sandbox session. Fixture success is not production sending readiness.

## Handoff

Conductor imports `textusSmsAdapter` in `registry.ts`.
