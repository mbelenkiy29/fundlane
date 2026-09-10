# MIC-134 acceptance — Headway Capital adapter

Executed September 8, 2026. Scope: Headway Capital `FunderAdapter` with synthetic fixtures for required-field preflight, accepted submit, document receipt, Account ID, status/offer mapping, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/headway-capital.test.ts` — empty payload errors on business, email, owners, annual revenue, requested amount, loan purpose, application file, and bank statements; invalid EIN/SSN/email/revenue are actionable |
| Accepted submission | Passed | Valid application submits `ok: true` with stable Account ID `hwc_${attemptKey}`; `rawStatus` `In Underwriting`; `getStatus` → `submitted`; no terms on acknowledgement |
| Document receipt | Passed | `api_application` and `statement` become application and bank-statement receipts; replay of the same attemptKey returns the same receipt ids, Account ID, and a single external ref |
| Timeout / expired credential / replay without duplicates | Passed | Timeout reserves `hwc_attempt-timeout` then recovers on the same ref; expired password returns `provider_unavailable` with no new ref and 503 on status; completed attempt replay under an expired password keeps the original ref |
| Incomplete / action-required / offer-ready / issued / declined | Passed | Incomplete and Action Required → `pending` without terms; Offer Ready → `approved` with synthetic terms; Issued → `funded` with terms; Declined → `declined` without terms; outstanding document requests → `pending`; unknown raw stays `unknown` |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: true }`; `getStatus` implemented; `parseWebhook` absent |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit/status JSON omit username/password, expired token, and owner SSNs; fixtures never attach document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/headway-capital.test.ts
```

5/5 passed.

## Behavior

- Slug `headway-capital`. Status poll and offers; no webhooks.
- Validate: public-guide required set (business + owner + financials + application file + bank statements).
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`; Account ID is the durable external ref.
- Status: Application Incomplete / Action Required → `pending`; In Underwriting → `submitted`; Offer Ready / Contract Unsigned / Funding Pending → `approved`; Issued → `funded`; Declined → `declined`. Terms only on approved/funded offer fixtures.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter and mounts status refresh / offer reconciliation through MIC-113 / MIC-124.

## Local vs live gates

Local synthetic fixtures prove mapping, receipts, Account ID identity, status/offer mapping, and idempotent retries. Commercial Headway Capital sandbox credentials and current endpoint contracts are not production-verified. Mock success is not production integration readiness.
