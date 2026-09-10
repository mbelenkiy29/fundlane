# MIC-135 acceptance — Plexe adapter

Executed September 8, 2026. Scope: Plexe `FunderAdapter` with synthetic fixtures for highest-owner / revenue-or-deposits validation, inferred amount and purpose confirmation, Application ID acknowledgement, bank-statement receipts, status retrieval, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/plexe.test.ts` — empty payload errors on business name, ZIP, owners, and annual revenue or statement deposits; incomplete highest-ownership owner is a field error even when a lower-ownership owner is complete; inferred amount/purpose without confirmation preview 100000 and Working Capital |
| Accepted submission | Passed | Valid application with `confirmInferredTerms` submits `ok: true` with stable `plexe_${attemptKey}`; highest owner Alex at 55%; monthly revenue 50000 from annual 600000; inferred amount 100000 and purpose Working Capital; `getStatus` → `submitted` / `Sent`; no terms |
| Document receipt | Passed | Bank `statement` is receipted; `api_application` is not uploaded; replay of the same attemptKey returns the same receipt id and a single Application ID |
| Timeout / expired credential / replay without duplicates | Passed | Timeout reserves `plexe_attempt-timeout` then recovers on the same ref; expired token returns `provider_unavailable` with no new ref and 503 on status; completed attempt replay under an expired token keeps the original ref |
| Status retrieval without invented offers | Passed | Submit acknowledgement is always `Sent`; later `plexe:declined` polls `Declined` / `declined` with no terms; unknown raw `CREDIT_COMMITTEE_HOLD` stays `unknown`; `offers` and `parseWebhook` are absent |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: false }`; `getStatus` implemented; `parseWebhook` absent |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit/status JSON omit API keys, expired token, and owner SSNs (last four only); fixtures never attach document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/plexe.test.ts
```

5/5 passed.

## Behavior

- Slug `plexe`. Status poll only; no webhooks or offer terms.
- Validate: one owner by highest ownership percentage; annual revenue or statement deposits; preview and confirm inferred requested amount (2× monthly revenue) and purpose (`Working Capital`) when those fields are omitted.
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`; Application ID `plexe_<attemptKey>`; first acknowledgement `Sent`.
- Status: `Sent` / submitted; `In Review` / pending; `Approved` / approved; `Declined` / declined; `Funded` / funded; unknown raw stays visible with `unknown: true` and no terms.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter and mounts status refresh through MIC-113 / MIC-124.

## Local vs live gates

Local synthetic fixtures prove mapping, receipts, inferred-term confirmation, status retrieval, and idempotent retries. Commercial Plexe sandbox credentials and current endpoint contracts are not production-verified. Mock success is not production integration readiness.
