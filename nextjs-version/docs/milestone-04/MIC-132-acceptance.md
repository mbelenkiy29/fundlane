# MIC-132 acceptance — Fundomate adapter

Executed September 8, 2026. Scope: submit-only Fundomate `FunderAdapter` with synthetic fixtures for application/owner/document mapping, Texas requested-amount validation, normalized EIN, acknowledgement receipts, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/fundomate.test.ts` — empty payload errors on business identity, owners, signed application, and bank statements; Texas without amount is a field error; invalid EIN/SSN/owner name are actionable; recommended owner email/phone/DOB may be omitted |
| Accepted submission | Passed | Valid application submits `ok: true` with stable `fm_${attemptKey}`; dashed EIN → `123456789`; `s_corporation` → S-Corporation; restaurant → Food Services; start `2019-06`; Texas amount `25000`; raw status `Received`; no terms |
| Document receipt | Passed | `api_application` and `statement` become signed-application and bank-statement receipts; replay of the same attemptKey returns the same receipt ids and a single external ref |
| Timeout / expired credential / replay without duplicates | Passed | Missing documents return `validation_failed` with no ref; timeout reserves `fm_attempt-timeout` then recovers on the same ref; expired client secret returns `provider_unavailable` with no new ref; completed attempt replay under an expired token keeps the original ref |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: false, webhooks: false, offers: false }`; `getStatus` / `parseWebhook` absent; `assertStatusPollAllowed` is 409 `capability_unsupported` |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit JSON omits client id/secret, expired token, and owner SSNs; fixtures never attach document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/fundomate.test.ts
```

5/5 passed.

## Behavior

- Slug `fundomate`. Submit-only acknowledgement; no webhooks, status poll, or offer terms.
- Validate: at least one owner (name/address/SSN); Texas requested amount; EIN as 9 digits; signed application + bank statements.
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`.
- Status after send is email/manual. This adapter does not poll or create offers.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter. Status refresh stays hidden/409 through MIC-113 / MIC-124 because `statusPoll` is false.

## Local vs live gates

Local synthetic fixtures prove mapping, receipts, Texas/EIN validation, and idempotent retries. Commercial Fundomate sandbox credentials and current endpoint contracts are not production-verified. Mock success is not production integration readiness.
