# MIC-137 acceptance — Idea Financial adapter

Executed September 8, 2026. Scope: Idea Financial `FunderAdapter` with synthetic fixtures for originator-phone fallback, nine-digit EIN, revenue derivation, all-owner submit, Application Number, document receipts, status/offer/link/stip mapping, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/idea-financial.test.ts` — empty payload errors on business name, legal structure, EIN, phone, owners, originator phone, and revenue derivation; invalid EIN/SSN/ownership are field errors; submitter phone satisfies originator fallback; statement deposits derive monthly revenue |
| Accepted submission | Passed | Valid application submits `ok: true` with stable Application Number `idea_${attemptKey}`; `rawStatus` `Processing`; all three owners mapped; annual 720000 → monthly 60000 and inferred amount 120000; FICO 650 / NAICS 999999; originator source `submitter`; `getStatus` → `submitted` with no terms |
| Document receipt | Passed | `api_application` and `statement` become application and bank-statement receipts; replay of the same attemptKey returns the same receipt ids, Application Number, and a single external ref |
| Timeout / expired credential / replay without duplicates | Passed | Timeout reserves `idea_attempt-timeout` then recovers on the same ref; expired password/clientSecret returns `provider_unavailable` with no new ref and 503 on status; completed attempt replay under an expired password keeps the original ref |
| Status / offers / links / stips | Passed | Incomplete → `pending` without terms; Offer → `approved` with synthetic terms, checkout `offerLink`, and stips on `rawStatus`; Funded → `funded` with terms; Declined → `declined` without terms; unknown raw `CREDIT_COMMITTEE_HOLD` stays `unknown` |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: true }`; `getStatus` implemented; `parseWebhook` absent |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit/status JSON omit username/password/client id/secret, expired token, and owner SSNs; fixtures never attach document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/idea-financial.test.ts
```

5/5 passed.

## Behavior

- Slug `idea-financial`. Status poll and offers; no webhooks.
- Validate: public-guide required set (business + all owners + originator/submitter mobile + 9-digit EIN + revenue derivation). Documents recommended only.
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`; Application Number is the durable external ref.
- Status: Draft / Processing → `submitted`; Submission Incomplete / Dormant → `pending`; offer/closing family → `approved`; Funded / Closed / Open → `funded`; Declined / Not Interested / Abandoned → `declined`. Terms and checkout link only on approved/funded offer fixtures; stips remain on `rawStatus`.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter and mounts status refresh / offer reconciliation through MIC-113 / MIC-124.

## Local vs live gates

Local synthetic fixtures prove mapping, receipts, Application Number identity, status/offer/link/stip mapping, and idempotent retries. Commercial Idea Financial sandbox credentials and current endpoint contracts are not production-verified. Mock success is not production integration readiness.
