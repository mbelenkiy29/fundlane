# MIC-136 acceptance — Fora Financial adapter

Executed September 8, 2026. Scope: Fora Financial `FunderAdapter` with synthetic fixtures for primary-owner / recorded credit-pull consent validation, Application ID acknowledgement, recommended document receipts, funding-stage status retrieval, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/fora-financial.test.ts` — empty payload errors on business identity, DBA, EIN, industry, entity type, start date, funding amount, owners, financials, and both credit-pull consents; omitted consent is not assumed true; explicit false consent is rejected; incomplete primary owner is a field error |
| Accepted submission | Passed | Valid application submits `ok: true` with stable `fora_${attemptKey}`; highest owner Alex at 55%; entity `S-Corporation`; industry `Food Services`; monthly revenue 50000 from annual 600000; recorded business and owner consent; `getStatus` → `submitted` / `In Progress`; no terms |
| Document receipt | Passed | `api_application` and bank `statement` are receipted; `voided_check` is not; replay of the same attemptKey returns the same receipt ids and a single Application ID |
| Timeout / expired credential / replay without duplicates | Passed | Timeout reserves `fora_attempt-timeout` then recovers on the same ref; expired token returns `provider_unavailable` with no new ref and 503 on status; completed attempt replay under an expired token keeps the original ref |
| Funding-stage status without invented offers | Passed | Incomplete Application / pending; Pending Funding / approved with no terms; Declined / declined with no terms; unknown raw `CREDIT_COMMITTEE_HOLD` stays `unknown`; `offers` and `parseWebhook` are absent |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: false }`; `getStatus` implemented; `parseWebhook` absent |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit/status JSON omit API keys, expired token, and owner SSNs; fixtures never attach document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/fora-financial.test.ts
```

5/5 passed.

## Behavior

- Slug `fora-financial`. Status poll only; no webhooks or offer terms. Portal “Open in Fora” is a provider UI action, not a webhook capability.
- Validate: one owner by highest ownership percentage; recorded credit-pull consent for business and that owner; financials from annual/monthly revenue or statement deposits; funding amount required.
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`; Application ID `fora_<attemptKey>`; first acknowledgement `In Progress` (or `Incomplete Application`).
- Status: Incomplete Application / pending; In Progress / submitted; Approved, Contracts In, Pending Funding / approved; Funded / funded; Declined / declined; unknown raw stays visible with `unknown: true` and no terms.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter and mounts status refresh through MIC-113 / MIC-124.

## Local vs live gates

Local synthetic fixtures prove mapping, recorded consent, receipts, funding-stage status retrieval, and idempotent retries. Commercial Fora sandbox credentials and current endpoint contracts are not production-verified. Mock success is not production integration readiness.
