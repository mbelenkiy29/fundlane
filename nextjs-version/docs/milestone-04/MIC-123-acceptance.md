# MIC-123 acceptance — Expansion Capital Group adapter

Executed September 8, 2026. Scope: Expansion Capital Group `FunderAdapter` with synthetic fixtures for application/owner/document mapping, status and missing-info polling, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/expansion-capital-group.test.ts` — empty payload errors on business, owners, and registered partner attribution; unregistered partner email is a field error; invalid EIN/SSN/owner fields are actionable |
| Accepted submission | Passed | Valid application submits `ok: true` with stable `ecg_${attemptKey}`; top two owners by percentage; `s_corporation` → Corporation; landlord blank; `getStatus` → `submitted` / `New Submission`; no terms |
| Document receipt | Passed | `api_application` and `statement` become application and bank-statement receipts; replay of the same attemptKey returns the same receipt ids and a single external ref |
| Timeout / expired credential / replay without duplicates | Passed | Timeout reserves `ecg_attempt-timeout` then recovers on the same ref; expired token returns `provider_unavailable` with no new ref and 503 on status; completed attempt replay under an expired token keeps the original ref |
| Outstanding document requests → pending | Passed | `UW Prep` plus outstanding bank statements/voided check maps to `pending` with the requests in `rawStatus`; known public statuses map; unknown raw stays `unknown` |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: false }`; `getStatus` implemented; `parseWebhook` absent |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit/status JSON omit API keys, expired token, and owner SSNs; fixtures never attach document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/expansion-capital-group.test.ts
```

5/5 passed.

## Behavior

- Slug `expansion-capital-group`. Status poll only; no webhooks or offer terms.
- Validate: up to two owners ordered by percentage; registered partner email + rep name required.
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`.
- Status: New Submission / UW Prep / Ready to UW / On Hold → `submitted`; outstanding document requests → `pending`; Soft Approval and contract stages → `approved`; Funded → `funded`; Declined / Outside Funded / Dead / Unwind → `declined`.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter and mounts status refresh through MIC-113 / MIC-124.

## Local vs live gates

Local synthetic fixtures prove mapping, receipts, status/missing-info, and idempotent retries. Commercial Expansion Capital Group sandbox credentials and current endpoint contracts are not production-verified. Mock success is not production integration readiness.
