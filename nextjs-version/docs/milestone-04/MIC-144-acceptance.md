# MIC-144 acceptance — OnDeck adapter

Executed September 8, 2026. Scope: OnDeck `FunderAdapter` with synthetic fixtures for business/owner/statement mapping, App ID and portal navigation, document receipts, offer/decline status retrieval, unsupported-outcome preservation, negative ADB source-fact handling, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/ondeck.test.ts` — empty payload errors on business identity, owners, and statement revenue/ADB; application and bank files are not required; unknown MetricEvidence and invalid EIN/SSN/period/revenue/owner phone fail with actionable field errors; zero ADB plus monthly revenue validates |
| Negative ADB without overwriting source facts | Passed | Negative source ADB validates; mapped snapshot keeps `-125.5` and sets outbound `submittedAverageDailyBalance` to `0`; original payload ADB is unchanged |
| Accepted submission | Passed | Valid application submits `ok: true` with stable `ondeck_${attemptKey}` App ID, synthetic portal URL, `Application Received` / `submitted`; acknowledgement has no offer terms |
| Document receipt | Passed | `api_application` and `statement` become application and bank-statement receipts; replay of the same attemptKey returns the same receipt ids, portal URL, and a single App ID; submit without files still succeeds |
| Timeout / expired credential / replay without duplicates | Passed | Timeout reserves `ondeck_attempt-timeout` then recovers on the same ref; expired apiKey/username/password return `provider_unavailable` with no new ref and 503 on status; completed attempt replay under an expired token keeps the original App ID |
| Offers / declines / unsupported outcomes | Passed | Offer → `approved` with synthetic terms and offer link; Declined → `declined` without terms; Hold / Funded / CREDIT_COMMITTEE_HOLD stay `unknown` with original raw values and no terms |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: true }`; `getStatus` implemented; `parseWebhook` absent |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit/status JSON omit API key, username, password, expired token, and owner SSNs; fixtures never attach document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/ondeck.test.ts
```

5/5 passed.

## Behavior

- Slug `ondeck`. Status poll and offers; no webhooks.
- Validate: business + owner details required (owner phone included); at least one statement with revenue and average daily balance required; application/bank files recommended, not required.
- Negative ADB: source fact is preserved; outbound clamp is `$0` only.
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`; App ID `ondeck_${attemptKey}`; synthetic portal URL only (`portal.example.test`).
- Status: Application Received / Received / Submitted / Sent / New Submission → `submitted`; Offer / Offered / Approved → `approved`; Declined / Decline / Rejected → `declined`. Unpublished values remain unknown for email/manual review.
- Offers: terms only on the offer fixture. Application Received acknowledgements and declines do not invent amounts.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter and mounts status refresh and offer reconciliation through MIC-113 / MIC-124.

## Local vs live gates

Local synthetic fixtures prove mapping, receipts, App ID/portal fields, offer/decline retrieval, unsupported-outcome preservation, negative ADB handling, and idempotent retries. Commercial OnDeck sandbox credentials and current endpoint contracts are not production-verified. Mock success is not production integration readiness.
