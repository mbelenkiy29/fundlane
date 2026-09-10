# MIC-141 acceptance — Lendini adapter

Executed September 8, 2026. Scope: Lendini `FunderAdapter` with synthetic fixtures for highest-ownership owner selection, industry/entity normalization, asynchronous acknowledgement plus later offer/decline polling, document receipts, unsupported-outcome preservation, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/lendini.test.ts` — empty payload errors on business identity, inception date, and owners; application and bank files are not required; only the highest-ownership owner is validated; invalid EIN/SSN/phone/date fail with actionable field errors |
| Accepted submission | Passed | Valid application submits `ok: true` with stable `lendini_${attemptKey}` application id, `Received` / `submitted` acknowledgement, one owner (55%), `Corp` entity, `Food Services` industry; acknowledgement has no offer terms |
| Document receipt | Passed | `api_application` and `statement` become application and bank-statement receipts; replay of the same attemptKey returns the same receipt ids, acknowledgement, and a single application id; submit without files still succeeds |
| Timeout / expired credential / replay without duplicates | Passed | Timeout reserves `lendini_attempt-timeout` then recovers on the same ref with `Received`; expired token returns `provider_unavailable` with no new ref and 503 on status; completed attempt replay under an expired token keeps the original application id |
| Offers / declines / unsupported outcomes | Passed | Submit stays `Received`; status poll Offer → `approved` with synthetic terms and offer link; Declined → `declined` without terms; Hold / Funded / CREDIT_COMMITTEE_HOLD stay `unknown` with original raw values and no terms |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: true }`; `getStatus` implemented; `parseWebhook` absent |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit/status JSON omit API keys, expired token, and owner SSNs; fixtures never attach document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/lendini.test.ts
```

5/5 passed.

## Behavior

- Slug `lendini`. Status poll and offers; no webhooks.
- Validate: business + inception date required; only the highest-ownership owner is required and mapped; application/bank files recommended, not required.
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`; application id `lendini_${attemptKey}`; always retains initial `Received` acknowledgement.
- Status: Received / Submitted / Acknowledged / Processing / New Submission → `submitted`; Offer / Offered / Approved → `approved`; Declined / Decline / Rejected → `declined`. Unpublished values remain unknown for email/manual review.
- Offers: terms only on the offer fixture, retrieved by status poll. Submitted acknowledgements and declines do not invent amounts.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter and mounts status refresh and offer reconciliation through MIC-113 / MIC-124.

## Local vs live gates

Local synthetic fixtures prove mapping, receipts, acknowledgement retention, offer/decline retrieval, unsupported-outcome preservation, and idempotent retries. Commercial Lendini sandbox credentials and current endpoint contracts are not production-verified. Mock success is not production integration readiness.
