# MIC-142 acceptance — Lendr adapter

Executed September 8, 2026. Scope: Lendr `FunderAdapter` with synthetic fixtures for business/owner/document mapping, Deal ID and portal navigation, document receipts, Check Status mapping without offer terms, unsupported-outcome preservation, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/lendr.test.ts` — empty payload errors on business identity, owners, application file, and bank statements; owner phone is required; invalid EIN/SSN/phone fail with actionable field errors; annual revenue is not required |
| Accepted submission | Passed | Valid application submits `ok: true` with stable `lendr_${attemptKey}` Deal ID, synthetic portal URL, `Submitted` / `submitted`; acknowledgement has no offer terms |
| Document receipt | Passed | `api_application` and `statement` become application and bank-statement receipts; replay of the same attemptKey returns the same receipt ids, portal URL, and a single Deal ID; missing application/bank files fail without minting a ref |
| Timeout / expired credential / replay without duplicates | Passed | Timeout reserves `lendr_attempt-timeout` then recovers on the same ref; expired token returns `provider_unavailable` with no new ref and 503 on status; completed attempt replay under an expired token keeps the original Deal ID |
| Status / unsupported outcomes | Passed | In Review → `pending`; Approved / Declined / Funded map without terms; Offer / Hold / CREDIT_COMMITTEE_HOLD stay `unknown` with original raw values and no terms |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: false }`; `getStatus` implemented; `parseWebhook` absent |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit/status JSON omit API keys, expired token, and owner SSNs; fixtures never attach document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/lendr.test.ts
```

5/5 passed.

## Behavior

- Slug `lendr`. Status poll only; no webhooks or offer terms.
- Validate: business + owner details required; application file and bank statements required as separate artifacts.
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`; Deal ID `lendr_${attemptKey}`; synthetic portal URL only (`portal.example.test`).
- Status: Submitted / Received / Sent / New Submission → `submitted`; In Review / Pending / In Progress → `pending`; Approved → `approved`; Declined / Decline / Rejected → `declined`; Funded → `funded`. Unpublished values remain unknown for email/manual review. No terms are attached.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter and mounts status refresh through MIC-113 / MIC-124.

## Local vs live gates

Local synthetic fixtures prove mapping, receipts, Deal ID/portal fields, Check Status mapping, unsupported-outcome preservation, and idempotent retries. Commercial Lendr sandbox credentials and current endpoint contracts are not production-verified. Mock success is not production integration readiness.
