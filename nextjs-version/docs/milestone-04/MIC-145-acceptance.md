# MIC-145 acceptance — Credibly adapter

Executed September 8, 2026. Scope: Credibly `FunderAdapter` with synthetic fixtures for v2 application/files mapping, Loan ID, document receipts, available positions, Prequalified without offer terms, unsupported-outcome preservation, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/credibly.test.ts` — empty payload errors on business identity including industry, owners including address, available positions, application file, and bank statements; incomplete position rows, invalid EIN/SSN, and missing statements fail with actionable field errors; empty positions array validates |
| Accepted submission | Passed | Valid application submits `ok: true` with stable `crd_${attemptKey}` Loan ID, synthetic portal URL, `Submitted` / `submitted`; acknowledgement has no offer terms |
| Document receipt | Passed | `api_application` and `statement` become application and bank-statement receipts; replay of the same attemptKey returns the same receipt ids, portal URL, and a single Loan ID; submit without required files fails without minting a Loan ID |
| Timeout / expired credential / replay without duplicates | Passed | Timeout reserves `crd_attempt-timeout` then recovers on the same Loan ID; expired token returns `provider_unavailable` with no new ref and 503 on status; completed attempt replay under an expired token keeps the original Loan ID |
| Prequalified / Offers Ready / declines / unsupported outcomes | Passed | Prequalified → `pending` with no terms; Offers Ready → `approved` with no terms; Declined → `declined` without terms; outstanding documents → `pending`; Max Advance / CREDIT_COMMITTEE_HOLD stay `unknown` with original raw values and no terms |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: false }`; `getStatus` implemented; `parseWebhook` absent |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit/status JSON omit API keys, expired token, and owner SSNs; fixtures never attach document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/credibly.test.ts
```

5/5 passed.

## Behavior

- Slug `credibly`. Status poll only; no webhooks; no priced API offers.
- Validate: business + owner address + industry + start date + files + available positions (empty array allowed).
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`; Loan ID `crd_${attemptKey}`; synthetic portal URL only (`portal.example.test`).
- Status: Submitted family → `submitted`; Prequalified → `pending` without terms; Offers Ready → `approved` without terms; Declined → `declined`; Funded → `funded`. Unpublished values remain unknown for email/manual review.
- Offers: never attached. Do not auto-create priced offers from Prequalified.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter and mounts status refresh through MIC-113 / MIC-124. Do not enable offer reconciliation for this slug.

## Local vs live gates

Local synthetic fixtures prove mapping, receipts, Loan ID/portal fields, Prequalified-without-terms, Offers Ready without invented amounts, unsupported-outcome preservation, and idempotent retries. Commercial Credibly sandbox credentials and current v2 endpoint contracts are not production-verified. Mock success is not production integration readiness.
