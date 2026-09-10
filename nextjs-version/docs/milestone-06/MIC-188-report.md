# MIC-188 report — TextUs SMS provider adapter

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-188/textus-sms-provider-adapter
**Status:** implemented locally with public-docs fixtures. Conductor registers the adapter; do not mark Linear Done from this agent.

## What shipped

`textusSmsAdapter` (`slug: textus`) implements `SmsAdapter` in `src/lib/mca/sms/adapters/textus`. Credentials are account email (`accountEmail`) and API key (`apiKey`). `email` / `token` / `apiToken` / `authToken` aliases are accepted. `validate` returns field errors on those keys. Optional `webhookSecret` is rejected only when present and blank.

Public mapping (https://apidocs.next.textus.com/, base `https://next.textus.com`):

- Auth: `Authorization: Bearer {apiKey}` and `Accept` / `Content-Type` `application/vnd.textus+jsonld`
- Send: `POST /messages` (send without account) `{ email, to, body, from? }`. `from` is set only when `senderIdentity` is E.164. Account slug `POST /:account/messages` is not used because the ticket credentials do not include an account slug.
- Send identity is the documented Message `id` (`/messages/…`). HTTP 201 without an id, 202 with no body, and transport errors are `unknown`.
- `statusCallbackUrl` is accepted on the port and unused: TextUs registers webhooks on the account integration, not per send.

`send` uses fixture outcomes for the synthetic API key and the extracted Messages client when a fetch implementation is injected. Missing email or API key is `textus_unconfigured`. Correlation id retries reuse the first result and do not invent a second `/messages/…` identity.

`parseStatus` maps documented `message.delivered` / `message.failed` / `message.unknown` deliveries. Replay of the same webhook `id` keeps one `eventKey`. Signature validation is the documented HMAC-SHA256 hex digest of the raw body (`X-TextUs-Signature`).

`parseInbound` maps `message.received`, `contact.opted_out`, `contact.opted_in`, and inbound `STOP`/`START` keywords.

| Flag | Value | Why |
| --- | --- | --- |
| `send` | `true` | Documented `POST /messages` |
| `statusCallbacks` | `true` | Documented `message.delivered` / `message.failed` / `message.unknown` payloads and HMAC signature |
| `inbound` | `true` | Documented `message.received` |
| `optOut` | `true` | Documented `contact.opted_out` / `contact.opted_in` |

Did not edit `sms/adapters/registry.ts` or `sms/service.ts`.

## Files

- `src/lib/mca/sms/adapters/textus/index.ts`
- `src/lib/mca/sms/adapters/textus/mapping.ts`
- `src/lib/mca/sms/adapters/textus/fixtures.ts`
- `tests/sms-adapters/textus.test.ts`
- `docs/milestone-06/MIC-188-report.md`
- `docs/milestone-06/MIC-188-acceptance.md`

## Checks

```bash
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/sms-adapters/textus.test.ts
```

8 adapter tests passed. ESLint clean on exclusive files. No live SMS. Fixtures and injected fetch only. Secrets are not copied into delivery results or sanitized 4xx messages.

## Remaining gate

Live TextUs account, API token, sending number or default messaging account, and handset delivery. Fixture success is not production integration readiness. Per-send callback URLs are not a TextUs send field; webhook subscription is account-level.

## Handoff

Import `textusSmsAdapter` in `src/lib/mca/sms/adapters/registry.ts` after review.
