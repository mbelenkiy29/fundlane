# MIC-187 acceptance — TextTorrent SMS adapter

Linear: https://linear.app/michael-belenkiy/issue/MIC-187/texttorrent-sms-provider-adapter

Executed against public TextTorrent API docs (https://texttorrent.com/docs/api). Scope: `SmsAdapter` for slug `texttorrent` with API key, secret, and sending number, synthetic fixtures, honest capability flags. Live TextTorrent send is out of scope. Conductor registers the adapter after review.

## Linear boxes

| Criterion | Result | Evidence |
| --- | --- | --- |
| A provider sandbox/mock verifies routing, successful send and rejected-number behavior | Pass | Fixture send of `Exact synthetic TextTorrent preview` is `accepted` with a stable numeric `data.id`. Create posts `{ receiver_number, sender_id }` to `https://api.texttorrent.com/api/v1/inbox/chat/create`, then multipart `message`/`chat_id`/`from_number`/`to_number` to `/api/v1/inbox/chat`. Recipient `+15550000999` is `failed` / `texttorrent_invalid_number` with no phone, body, or secret in the error. |
| A retried callback updates the existing message without duplicate delivery records | Skipped | `statusCallbacks: false`. Public docs have no outbound DLR payload or signature. Inbox best practices mention polling or unspecified webhooks. `parseStatus` is unimplemented. |
| Realistic synthetic scenario with expected output | Pass | Accepted, rejected-number, timeout, unconfigured, expired secret, existing-chat lookup (`404` already started → `GET /inbox?search=` → send). |
| Loading, empty, validation, success and failure; retries preserve identity | Pass | Empty `validate({})` returns API key, secret, and sending-number field errors. Timeout and unconfigured retries return the first result with no new external id. |
| Direct API requests enforce the same permissions as the UI. Logs exclude secrets | Pass | Adapter has no HTTP surface. Delivery results omit API secret, recipient, and body on rejected-number. |

## Expected synthetic output

- Missing fields: `{ ok: false, fields: { apiKey, apiSecret, sendingNumber } }`
- Accepted send: `{ state: "accepted", providerStatus: "sent", externalId: "<numeric id>" }`
- Rejected number: `{ state: "failed", errorCode: "texttorrent_invalid_number" }`
- Timeout: `{ state: "unknown", errorCode: "provider_outcome_unknown", externalId: undefined }`
- Unconfigured: `{ state: "failed", errorCode: "texttorrent_unconfigured" }`
- Capabilities: `{ send: true, statusCallbacks: false, inbound: false, optOut: false }`

## Commands

```bash
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/sms-adapters/texttorrent.test.ts
```

8/8 passed.

## Behavior

- Credentials: `apiKey` + `apiSecret` + `sendingNumber` (Linear: API key, secret, sending number). Mapped to `X-API-SID` and `X-API-PUBLIC-KEY`.
- `testConnection` is `ok` only when `account.providerConfigured`.
- Default send is fixture-backed (`texttorrentFixtureFetch`). No live `api.texttorrent.com` call from this ticket.
- Create-chat `receiver_number` strips `+1` for NANP. Non-US numbering needs sandbox verification.
- `statusCallbackUrl` is accepted on the port and unused.

## Local vs live gates

Local fixtures prove mapping, idempotency, rejected-number, timeout identity, existing-chat lookup, and secret redaction. There is no TextTorrent sandbox session. Fixture success is not production sending readiness.
