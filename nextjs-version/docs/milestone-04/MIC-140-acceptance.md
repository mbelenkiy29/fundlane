# MIC-140 acceptance — Bitty Advance adapter

Executed September 8, 2026. Scope: Bitty Advance `FunderAdapter` with synthetic fixtures for business/owner/statement mapping, Deal ID and portal navigation, document receipts, offer/decline status retrieval, unsupported-outcome preservation, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/bitty-advance.test.ts` — empty payload errors on business identity, owners, and statement revenue/negative days; application and bank files are not required; unknown MetricEvidence and invalid EIN/SSN/period/revenue fail with actionable field errors; zero negative days plus monthly revenue validates |
| Accepted submission | Passed | Valid application submits `ok: true` with stable `bitty_${attemptKey}` Deal ID, synthetic portal URL, `Submitted` / `submitted`; acknowledgement has no offer terms |
| Document receipt | Passed | `api_application` and `statement` become application and bank-statement receipts; replay of the same attemptKey returns the same receipt ids, portal URL, and a single Deal ID; submit without files still succeeds |
| Timeout / expired credential / replay without duplicates | Passed | Timeout reserves `bitty_attempt-timeout` then recovers on the same ref; expired token returns `provider_unavailable` with no new ref and 503 on status; completed attempt replay under an expired token keeps the original Deal ID |
| Offers / declines / unsupported outcomes | Passed | Offer → `approved` with synthetic terms and offer link; Declined → `declined` without terms; Hold / Funded / CREDIT_COMMITTEE_HOLD stay `unknown` with original raw values and no terms |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: true }`; `getStatus` implemented; `parseWebhook` absent |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit/status JSON omit API keys, expired token, and owner SSNs; fixtures never attach document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/bitty-advance.test.ts
```

5/5 passed.

## Behavior

- Slug `bitty-advance`. Status poll and offers; no webhooks.
- Validate: business + owner details required; at least one statement with revenue and negative days required; application/bank files recommended, not required.
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`; Deal ID `bitty_${attemptKey}`; synthetic portal URL only (`portal.example.test`).
- Status: Submitted / Received / Sent / New Submission → `submitted`; Offer / Offered / Approved → `approved`; Declined / Decline / Rejected → `declined`. Unpublished values remain unknown for email/manual review.
- Offers: terms only on the offer fixture. Submitted acknowledgements and declines do not invent amounts.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter and mounts status refresh and offer reconciliation through MIC-113 / MIC-124.

## Local vs live gates

Local synthetic fixtures prove mapping, receipts, Deal ID/portal fields, offer/decline retrieval, unsupported-outcome preservation, and idempotent retries. Commercial Bitty Advance sandbox credentials and current endpoint contracts are not production-verified. Mock success is not production integration readiness.
