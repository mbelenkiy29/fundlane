# MIC-185 report — Entrance SMS adapter

**Status:** DONE locally with public-docs fixtures. Commercial Entrance sandbox access remains an external gate.

## Contract

`entranceSmsAdapter` (`slug: entrance`) implements `SmsAdapter` from `sms/contracts.ts`. Credentials are customer login email (`loginEmail`) and API secret/password (`apiSecret`). `email` / `password` aliases are accepted. `validate` returns field errors on those keys.

Public mapping (https://docs.entrancegrp.com/, npm `entrancesms`, base `https://apiv2.entrancegrp.com`):

- Login: `POST /authentication/login` `{ email, password }` → `record.access_token`, `record.workspace_id`
- Send: `POST /workspaces/:workspaceId/messages` with `Authorization: Bearer` and body `{ channel_id?, message, number }`
- `channel_id` is the documented send field (numeric conversation channel, example `1028`). It is set only when `senderIdentity` is a positive integer. An E.164 sending number does not invent a channel id.
- `number` is the recipient. The published send-message example omits it; the field name is taken from public campaign-test and create-contact bodies so 1:1 merchant texting can be expressed. Production channel/recipient pairing needs sandbox verification.
- Send response identity is not published. Fixtures use the login-style `{ record: { id, status } }` wrapper. Missing id → `unknown`.

`send` is fixture-backed (`fixture://entrance/messages`). It does not call live Entrance. Idempotent on `correlationId`: accepted and rejected results replay without a second provider call; a timeout then recover mints one external id.

Capability flags are honest:

| Flag | Value | Why |
| --- | --- | --- |
| `send` | `true` | Documented messages send |
| `statusCallbacks` | `false` | `messageStatus` is a webhook subscription name, but outbound DLR payload and signature validation are not in public docs (`/message-status/campaign` is campaign-only). `parseStatus` is not implemented |
| `inbound` | `true` | Documented `newMessage` subscription and `POST /receive-sms/receive` Telnyx-shaped envelope |
| `optOut` | `true` | Inbound `START`/`STOP`, incoming-message-keywords, unsubscribe filters, `getStops` |

`parseInbound` maps the public receive-SMS envelope: `STOP`/`STOPALL`/`UNSUBSCRIBE`/`CANCEL`/`END`/`QUIT` → `opt_out`; `START`/`UNSTOP`/`YES` → `opt_in`; other inbound text → `message`. Outbound or empty payloads are ignored.

Error messages are canned. They do not include the login email, API secret, recipient, or body.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/sms-adapters/entrance.test.ts
```

7/7 passed.

Covered: required-field rejection; accepted send (login URL, Bearer send, `channel_id` + `message` + `number`); rejected-number without leaking PII; timeout then recover without a second id; unconfigured / expired credential; capability flags; inbound START/STOP; phone sender omits `channel_id`; secrets omitted.

Retried status-callback duplicate-row test skipped: `statusCallbacks` is false.

## Files

- `src/lib/mca/sms/adapters/entrance/index.ts`
- `src/lib/mca/sms/adapters/entrance/mapping.ts`
- `src/lib/mca/sms/adapters/entrance/fixtures.ts`
- `tests/sms-adapters/entrance.test.ts`
- `docs/milestone-06/MIC-185-report.md`
- `docs/milestone-06/MIC-185-acceptance.md`

Did not edit `registry.ts`, `sms/contracts.ts`, or Twilio.

## Remaining gates

Commercial Entrance sandbox: live login, workspace/channel resolution for an E.164 sender, send response schema, and whether delivery webhooks can be signed. Fixture success is not production delivery.

## Handoff

Conductor registers `entranceSmsAdapter` in `src/lib/mca/sms/adapters/registry.ts` after review. Do not enable status callbacks for this slug until the DLR contract is verified.
