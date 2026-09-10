# MIC-191 report — GoHighLevel SMS provider adapter

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-191/gohighlevel-sms-provider-adapter
**Status:** implemented locally with public-docs fixtures. Conductor registers the adapter; do not mark Linear Done from this agent.

## What shipped

`gohighlevelSmsAdapter` (`slug: gohighlevel`) implements `SmsAdapter` in `src/lib/mca/sms/adapters/gohighlevel`. Credentials are Private Integration Token (`privateIntegrationToken`) and Location ID (`locationId`). `token` / `location` aliases are accepted. `validate` returns field errors on the canonical keys.

Public mapping (HighLevel API v2 / Private Integrations, base `https://services.leadconnectorhq.com`, `Version: 2021-07-28`):

- Auth: `Authorization: Bearer <Private Integration Token>` ([Private Integrations](https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken))
- Contact resolve: `GET /contacts/search/duplicate?locationId&number` then, if missing, `POST /contacts/upsert` `{ locationId, phone }` ([duplicate](https://marketplace.gohighlevel.com/docs/ghl/contacts/get-duplicate-contact), [upsert](https://marketplace.gohighlevel.com/docs/ghl/contacts/upsert-contact)). `GET /contacts/lookup` is documented OAuth-only and is not used.
- Send: `POST /conversations/messages` `{ type: "SMS", contactId, message, toNumber, fromNumber? }` ([send a new message](https://marketplace.gohighlevel.com/docs/ghl/conversations/send-a-new-message)). `fromNumber` is set only when `senderIdentity` is E.164. `statusCallbackUrl` is accepted on the port and unused: the send body has no per-message callback field.
- Send identity is `messageId`. Missing id → `unknown`. Initial `providerStatus` is `pending` (documented get-message status) unless the payload includes `status`.
- `parseStatus` maps documented `OutboundMessage` SMS payloads (`messageId`, `status`, `to`, `from`) to a stable `eventKey` over sorted keys. Replay of the same payload is the same key. Supported statuses are the get-message SMS set: `pending`, `scheduled`, `sent`, `connected`, `delivered`, `opened`, `clicked`, `read`, `failed`, `undelivered`, `opt_out`.
- `parseInbound` maps documented `InboundMessage` SMS: `STOP`/`STOPALL`/`UNSUBSCRIBE`/`CANCEL`/`END`/`QUIT` → `opt_out`; `START`/`UNSTOP`/`YES` → `opt_in`; other inbound text → `message`. Non-SMS and outbound envelopes are ignored.
- Signature helper `validateGhlWebhookSignature` uses the published Ed25519 public key for `X-GHL-Signature` ([Webhook Integration Guide](https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/)). HTTP-layer verification is for the conductor to mount; `parseStatus` maps the body the same way Twilio does.

`send` uses fixture outcomes for the synthetic PIT and the extracted transport when a fetch implementation is injected. Missing credentials are `gohighlevel_unconfigured`. Correlation id retries reuse the first result and do not invent a second `messageId`.

Capability flags:

| Flag | Value | Why |
| --- | --- | --- |
| `send` | `true` | Documented `POST /conversations/messages` with PIT |
| `statusCallbacks` | `true` | Documented `OutboundMessage` SMS webhook with `status` + get-message statuses. Location or marketplace webhook URL is a remaining mount; send does not set a callback URL |
| `inbound` | `true` | Documented `InboundMessage` SMS |
| `optOut` | `true` | Inbound STOP/START keywords and get-message `opt_out` |

Did not edit `sms/adapters/registry.ts` or `sms/service.ts`.

## Files

- `src/lib/mca/sms/adapters/gohighlevel/index.ts`
- `src/lib/mca/sms/adapters/gohighlevel/mapping.ts`
- `src/lib/mca/sms/adapters/gohighlevel/fixtures.ts`
- `tests/sms-adapters/gohighlevel.test.ts`
- `docs/milestone-06/MIC-191-report.md`
- `docs/milestone-06/MIC-191-acceptance.md`

## Checks

```bash
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/sms-adapters/gohighlevel.test.ts
```

8/8 passed. Secrets are not copied into delivery results or sanitized 4xx messages. No live SMS.

## Remaining gate

Live GoHighLevel sub-account: Private Integration Token with `conversations/message.write` and contacts scopes, LC Phone / Twilio number on the Location, contact upsert side effects, and a location or marketplace webhook URL for `InboundMessage` / `OutboundMessage`. Fixture acceptance is not production integration readiness.

## Handoff

Import `gohighlevelSmsAdapter` in `src/lib/mca/sms/adapters/registry.ts`. Mount status/inbound webhook routes only after signature verification with `X-GHL-Signature`.
