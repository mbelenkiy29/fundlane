# MIC-131 acceptance — Forward Financing adapter

Executed September 8, 2026. Scope: Forward Financing `FunderAdapter` with synthetic fixtures for application/owner/document mapping, missing-info until documents are complete, status polling for approvals and declines, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/forward-financing.test.ts` — empty payload errors on business, owners, industry, entity type, phone, start date, and EIN; unmapped industry is a picklist field error; invalid EIN/SSN/owner fields are actionable |
| Accepted submission | Passed | Valid application submits `ok: true` with stable `ff_${attemptKey}`; top two owners by percentage; `s_corporation` → S-Corporation; `Food Services` → Restaurants; `getStatus` → `submitted` / `Submitted`; no terms |
| Document receipt | Passed | `api_application` and `statement` become application and bank-statement receipts; replay of the same attemptKey returns the same receipt ids and a single external ref |
| Timeout / expired credential / replay without duplicates | Passed | Timeout reserves `ff_attempt-timeout` then recovers on the same ref; expired token returns `provider_unavailable` with no new ref and 503 on status; completed attempt replay under an expired token keeps the original ref |
| Missing-info until documents complete | Passed | `:missing-info` without docs is `Missing Info` / `pending` with bank statements and voided check in `rawStatus`; post-submit upload of those categories on the same attemptKey becomes `Submitted` / `submitted` with one external ref |
| Documented outcomes without priced offers | Passed | Approved → `approved`; Offered → `approved` with no `terms`; Declined → `declined`; unknown raw stays `unknown`; `offers: false` |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: false }`; `getStatus` implemented; `parseWebhook` absent |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit/status JSON omit API keys, expired token, and owner SSNs; fixtures never attach document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/forward-financing.test.ts
```

5/5 passed.

## Behavior

- Slug `forward-financing`. Status poll only; no webhooks. `offers` is false: public materials mention offer outcomes, but this adapter does not invent priced terms.
- Validate: up to two owners ordered by percentage; industry must match the discrete picklist.
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`. Post-submit document upload can clear missing-info on the same key.
- Status: Submitted / Application Received / In Review → `submitted`; outstanding document requests → `pending` until covered; Approved / Offered / Offer Issued → `approved` with no terms; Funded → `funded`; Declined → `declined`.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter and mounts status refresh through MIC-113 / MIC-124.

## Local vs live gates

Local synthetic fixtures prove mapping, receipts, missing-info readiness, approval/decline status, and idempotent retries. Commercial Forward Financing sandbox credentials and current endpoint contracts are not production-verified. Mock success is not production integration readiness.
