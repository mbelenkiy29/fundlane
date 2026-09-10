# MIC-139 acceptance — CAN Capital adapter

Executed September 8, 2026. Scope: CAN Capital `FunderAdapter` with synthetic fixtures for structured credentials, primary-owner age/phone and state-of-formation validation, application/document mapping, live status polling, and attemptKey idempotency. Live provider APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/can-capital.test.ts` — empty payload errors on business, funding amount, and owners; LLC and S-corporation missing formation are field errors; sole proprietor without formation is accepted; owner under 18 and non-10-digit phones are field errors |
| Accepted submission | Passed | Valid application submits `ok: true` with stable `can_${attemptKey}`; only highest-ownership owner Alex at 55%; `llc` → LLC with DE formation; `getStatus` → `submitted` / `Application Received`; no terms; credentials stay as separate components |
| Document receipt | Passed | `api_application` and `statement` become application and bank-statement receipts; replay of the same attemptKey returns the same receipt ids and a single Application Name |
| Timeout / expired credential / replay without duplicates | Passed | Timeout reserves `can_attempt-timeout` then recovers on the same ref; expired client secret or password returns `provider_unavailable` with no new ref and 503 on status; completed attempt replay under an expired partner key keeps the original ref |
| Outstanding documents and unknown outcomes | Passed | `Missing Information` plus outstanding application/bank statements maps to `pending`; Declined maps without terms; unknown raw `CREDIT_COMMITTEE_HOLD` stays `unknown` for email/manual review |
| Capability flags match implementation | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: false }`; `getStatus` implemented; `parseWebhook` absent |
| Loading / empty / validation / success / failure usable | Passed | `validate({})` is the empty/validation state; accepted submit is success; timeout and expired credential are failure states with correlation ids; retries preserve `attemptKey` identity |
| Logs omit secrets and sensitive document contents | Passed | Submit/status JSON omit partner key, client secret, general password, expired token, and owner SSNs; fixtures never attach document bytes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/can-capital.test.ts
```

5/5 passed.

## Behavior

- Slug `can-capital`. Status poll only; no webhooks or offer terms.
- Validate: one primary owner by highest ownership percentage; 10-digit phones; owner 18+; state of formation for Corporation / Partnership / LLC / LLP / Limited Partnership.
- Submit: fixtures keyed by `job.route.destination` or test override; idempotent on `job.attemptKey`; Application Name `can_<attemptKey>`; first acknowledgement `Application Received`.
- Status: Application Received → submitted; Missing Information / outstanding docs → pending; Approved / Declined / Funded mapped; unknown raw stays visible with `unknown: true` and no terms.
- Direct API permissions stay on MIC-124 credential routes. This ticket has no exclusive HTTP surface.

## UI

No exclusive UI. Conductor registers the adapter and mounts status refresh through MIC-113 / MIC-124.

## Local vs live gates

Local synthetic fixtures prove mapping, receipts, status/missing-info, unknown-outcome routing, and idempotent retries. Commercial CAN Capital sandbox credentials and current endpoint contracts are not production-verified. Mock success is not production integration readiness.
