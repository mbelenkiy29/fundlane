# MIC-189 report — OpenPhone SMS provider adapter

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-189/openphone-sms-provider-adapter
**Status:** implemented locally with synthetic fixtures. Conductor registers the adapter; do not mark Linear Done from this agent.

## What shipped

`openphoneSmsAdapter` (`slug: openphone`) implements `SmsAdapter` in `src/lib/mca/sms/adapters/openphone`. Layout matches the Twilio gold adapter.

Public mapping (Quo, formerly OpenPhone, v1 — https://www.quo.com/docs/mdx/api-reference/send-your-first-message, https://www.quo.com/docs/mdx/api-reference/messages/send-a-text-message, https://support.quo.com/core-concepts/integrations/webhooks):

- Auth: `Authorization: YOUR_API_KEY` (no Bearer prefix) to `https://api.quo.com`.
- Send: `POST /v1/messages` `{ content, from, to: [E.164], userId }` → HTTP 202 `{ data: { id: "AC…", status } }`. `from` is E.164 or `PN…`. `userId` is `US…`.
- Delivery webhooks: workspace `POST /v1/webhooks/messages` events `message.delivered` / `message.received`. Per-send `statusCallbackUrl` is accepted on the adapter port and omitted from the JSON body.
- Signature: `openphone-signature` `hmac;1;<unix>;<base64>` over `timestamp + "." + JSON.stringify(body)` with a base64-decoded HMAC-SHA256 key.
- Opt-out keywords (single-word): STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT; opt-in START / UNSTOP. HELP is ignored.

Credentials (Linear): API key (`apiKey`), user (`user`, alias `userId`), sending number (`sendingNumber`). `validate` returns field errors on those keys.

`send` uses fixture outcomes for the synthetic API key and the extracted Messages API client when a fetch implementation is injected. Missing API key or user is `openphone_unconfigured`. Correlation id retries reuse the first result and do not invent a second `AC` identity.

Capability flags are honest:

| Flag | Value | Why |
| --- | --- | --- |
| `send` | `true` | Documented `POST /v1/messages` |
| `statusCallbacks` | `true` | Documented `message.delivered` webhook; `parseStatus` implemented |
| `inbound` | `true` | Documented `message.received` webhook |
| `optOut` | `true` | Documented single-word STOP/START keywords on inbound text |

Did not edit `sms/adapters/registry.ts` or `sms/service.ts`.

## Files

- `src/lib/mca/sms/adapters/openphone/index.ts`
- `src/lib/mca/sms/adapters/openphone/mapping.ts`
- `src/lib/mca/sms/adapters/openphone/fixtures.ts`
- `tests/sms-adapters/openphone.test.ts`
- `docs/milestone-06/MIC-189-report.md`
- `docs/milestone-06/MIC-189-acceptance.md`

## Checks

```bash
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/sms-adapters/openphone.test.ts
```

8 adapter tests passed. No live SMS. Fixtures and injected fetch only. Secrets are not copied into delivery results or sanitized 4xx messages.

## Remaining gate

Live OpenPhone/Quo workspace: API key, `US…` user, E.164 sender, US carrier registration, prepaid API credits, and handset delivery. Fixture acceptance is not production integration readiness. The 2026-03-30 Standard-Webhooks scheme (`webhook-id` / `whsec_…`) is not interchangeable with v1 `openphone-signature` and is not implemented.

## Handoff

Import `openphoneSmsAdapter` in `src/lib/mca/sms/adapters/registry.ts` after review.
