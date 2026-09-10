# MIC-187 report — TextTorrent SMS adapter

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-187/texttorrent-sms-provider-adapter
**Status:** implemented locally with public-docs fixtures. Conductor registers the adapter; do not mark Linear Done from this agent.

## Contract

`texttorrentSmsAdapter` (`slug: texttorrent`) implements `SmsAdapter` from `sms/contracts.ts`. Credentials are API key (`apiKey`), secret (`apiSecret`), and sending number (`sendingNumber`). Aliases: `apiSid`/`sid`, `publicKey`/`apiPublicKey`, `fromNumber`/`from_number`. `validate` returns field errors on those Linear keys.

Public mapping (https://texttorrent.com/docs/api, base `https://api.texttorrent.com`):

- Auth headers: `X-API-SID` = API key, `X-API-PUBLIC-KEY` = secret. Public docs name the second header a public key; Linear calls it secret. There is no documented `X-API-SECRET`.
- Create conversation: `POST /api/v1/inbox/chat/create` JSON `{ receiver_number, sender_id }`. `receiver_number` is the documented NANP 10-digit form without `+1`. `sender_id` is the E.164 sending number.
- Send: `POST /api/v1/inbox/chat` multipart `{ message, chat_id, from_number, to_number }`. Success `201` identity is `data.id` (integer), status `data.api_send_status` (example `sent`).
- If create returns `404` "You have already started a chat with this contact.", look up `GET /api/v1/inbox?search=` and send to that `chat_id`.
- `statusCallbackUrl` is accepted on the port and unused: send has no documented callback URL field.

`send` is fixture-backed (`fixture://texttorrent/messages`). It does not call live TextTorrent. Idempotent on `correlationId`: accepted, rejected, timeout, and unconfigured results replay without a second provider call or a second external id.

Capability flags are honest:

| Flag | Value | Why |
| --- | --- | --- |
| `send` | `true` | Documented inbox send after create-chat |
| `statusCallbacks` | `false` | No documented outbound DLR webhook payload or signature. Inbox docs suggest polling or unspecified webhooks. `parseStatus` is not implemented |
| `inbound` | `false` | Inbox and claims are GET/poll. Marketing mentions reply webhooks; public API has no inbound envelope or signature |
| `optOut` | `false` | Provider auto-blocks STOP words in their inbox, but MCA cannot ingest those events without a documented inbound webhook |

Error messages are canned. They do not include the API key, secret, recipient, or body.

Did not edit `sms/adapters/registry.ts`.

## Files

- `src/lib/mca/sms/adapters/texttorrent/index.ts`
- `src/lib/mca/sms/adapters/texttorrent/mapping.ts`
- `src/lib/mca/sms/adapters/texttorrent/fixtures.ts`
- `tests/sms-adapters/texttorrent.test.ts`
- `docs/milestone-06/MIC-187-report.md`
- `docs/milestone-06/MIC-187-acceptance.md`

## Checks

```
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/sms-adapters/texttorrent.test.ts
```

8/8 passed. Synthetic fixtures only. No live SMS. Secrets are not copied into delivery results or sanitized 4xx messages.

## Remaining gate

Commercial TextTorrent sandbox: live SID + public key, active sending number, create-chat NANP vs non-US recipients, send `data.id` vs gateway `msg_sid`, and whether a signed inbound/DLR webhook exists. Fixture success is not production delivery.

## Handoff

Conductor registers `texttorrentSmsAdapter` in `src/lib/mca/sms/adapters/registry.ts` after review. Do not enable status callbacks or inbound for this slug until those contracts are verified.
