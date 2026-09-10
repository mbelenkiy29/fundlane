# MIC-184 useSend adapter

Selected provider: [useSend](https://docs.usesend.com). Official docs and the public OpenAPI spec cover sending, domains, and HMAC webhooks. Inbound mailboxes are an unchecked useSend feature and are not available on the public API.

## What MCA uses from the docs

- `POST https://app.usesend.com/api/v1/emails` with `Authorization: Bearer` and `Idempotency-Key` for intake receipts.
- `GET /v1/domains` to require a domain whose `status` is `SUCCESS` before storing a receipt From address.
- Webhook signatures: `HMAC-SHA256(secret, "${timestamp}.${rawBody}")` in `X-UseSend-Signature: v1=…` with `X-UseSend-Timestamp` (milliseconds, 5-minute skew).

## Honest inbound gap

useSend does not issue `hash@inbound…` addresses. Provisioning records the real workspace intake address the operator supplies and returns the HMAC webhook URL. MX, Google forwarding, or a Cloudflare Email Routing worker must POST `type: "email.received"` JSON to that URL. MCA never invents an inbound address.

## Local verification

`pnpm exec node --conditions=react-server --import tsx --test --test-concurrency=1 tests/intake-core.test.ts`

Live activation still needs a useSend API key, a SUCCESS domain, a real inbound mailbox pointed at the webhook, and one outbound receipt.
