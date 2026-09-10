# MIC-143 acceptance — Everest Business Funding adapter

Executed September 8, 2026. Scope: Everest Business Funding `FunderAdapter` with synthetic fixtures for business name/EIN mapping, distinct API application and statement files, Deal ID, document receipts, offer/decline status retrieval, unsupported-outcome preservation, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/everest-business-funding.test.ts` — empty payload errors on business name, EIN, API application file, and bank statements; invalid EIN and the same file used for both roles fail with actionable field errors; owners and phone are not required |
| Accepted submission | Passed | Valid application submits `ok: true` with stable `ebf_${attemptKey}` Deal ID, structured `clientId`/`clientSecret` mapping, `Submitted` / `submitted`; acknowledgement has no offer terms |
| Document receipt | Passed | `api_application` and `statement` become application and bank-statement receipts; replay of the same attemptKey returns the same receipt ids, Deal ID, and a single external ref |
| Timeout / expired credential / replay without duplicates | Passed | Missing files fail without a ref; timeout reserves `ebf_attempt-timeout` then recovers on the same ref; expired client secret returns `provider_unavailable` with no new ref and 503 on status; completed attempt replay under an expired secret keeps the original Deal ID |
| Offers / declines / unsupported outcomes | Passed | Offer → `approved` with synthetic terms and offer link; Declined → `declined` without terms; Hold / Funded / CREDIT_COMMITTEE_HOLD stay `unknown` with original raw values and no terms |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: true }`; `getStatus` implemented; `parseWebhook` absent |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit/status JSON omit client ID, client secret, and expired token; fixtures never attach document bytes; comma-joined API key blobs are not parsed |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/everest-business-funding.test.ts
```

5/5 passed.

## Behavior

- Slug `everest-business-funding`. Status poll and offers; no webhooks.
- Validate: business name + 9-digit EIN + distinct API application and bank-statement files.
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`; Deal ID `ebf_${attemptKey}`.
- Status: Submitted / Received / Sent / New Submission → `submitted`; Offer / Offered / Approved → `approved`; Declined / Decline / Rejected → `declined`. Unpublished values remain unknown for email/manual review.
- Offers: terms only on the offer fixture. Submitted acknowledgements and declines do not invent amounts.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter and mounts status refresh and offer reconciliation through MIC-113 / MIC-124.

## Local vs live gates

Local synthetic fixtures prove mapping, receipts, Deal ID identity, offer/decline retrieval, unsupported-outcome preservation, and idempotent retries. Commercial Everest Business Funding sandbox credentials and current endpoint contracts are not production-verified. Mock success is not production integration readiness.
