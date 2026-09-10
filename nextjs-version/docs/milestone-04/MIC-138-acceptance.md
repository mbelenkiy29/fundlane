# MIC-138 acceptance — PEAC Solutions direct funder API integration

Executed September 8, 2026. Scope: PEAC Solutions `FunderAdapter` with synthetic fixtures for required-field rejection, accepted submission, recommended document receipt, timeout / expired credential / attemptKey replay, three-owner mapping with 50% represented ownership, funding purpose, $250,000 amount bound, status poll with offer links and stips. Live PEAC APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/peac-solutions.test.ts` — empty `validate` returns legalName, entityType, address, phone, businessEmail, fundingPurpose, requestedAmount, annualRevenue, owners; fourth owner is rejected; represented ownership below 50% is a field error; requested amount above $250,000 is a field error; monthly revenue and statement deposits satisfy annual revenue |
| Up to three owners, 50% ownership, purpose of funds | Passed | Three-owner payload maps Sam/Alex/Jordan with 100% represented ownership; purpose `Working Capital`; requested amount 75000; fourth owner `PEAC Solutions accepts at most three owners.` |
| Accepted submission and document receipt | Passed | Submit returns `ok`, `externalRef` `peac_attempt-peac-1`, raw `In Process`; recommended application + bank-statement receipts are stable on replay; documents remain optional on validate |
| Timeout / expired credential / replay | Passed | Timeout keeps `peac_attempt-timeout` and recovers on the same ref; destination `peac-solutions:expired-credential` and expired runtime token are `provider_unavailable` without a new ref; accepted replay reuses the same external ref |
| Status, offers, and stips | Passed | In Process → `submitted` without terms; Incomplete + outstanding stipulations → `pending`; Offers Ready / Booked / Funded attach synthetic terms and offer link; Withdrawn / No PQ Offers Available → `declined` without terms; unknown raw preserved |
| Capability flags | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: true }`; `getStatus` present; `parseWebhook` omitted |
| Loading / empty / validation / success / failure; identity preserved | Passed | Empty validate; field-error submit; accepted submit; timeout and expired failures; retries of the same `attemptKey` keep correlation id and external ref |
| Secrets and document contents omitted | Passed | Results omit API key `peac-solutions-development-token-never-leak`, full SSN, and document bytes (checksum/category only) |
| Direct API matches UI permissions | N/A in adapter files | No exclusive HTTP. MIC-124/MIC-113 enforce `deals:write` submit/status and admin credentials; this adapter does not add routes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/peac-solutions.test.ts
```

5/5 passed.

## Behavior

- Typed application mapping in `mapping.ts` (business, ≤3 owners, ≥50% represented ownership, purpose of funds, requested amount ≤ $250,000, annual revenue or statement-derived revenue). Live field names and product codes are a provider-access gate.
- Fixtures in `fixtures.ts` keyed by `job.route.destination` or `setPeacSolutionsFixture`. First receipt per `attemptKey` wins.
- `getStatus` persists raw provider status, maps the documented PEAC outcomes, attaches offer terms only for approved/funded offer fixtures, and surfaces incomplete stips in `rawStatus`.
- Runtime username/password/apiKey from `adapterRuntime()` when MIC-124 injects credentials; expired token is `provider_unavailable`.

## UI

No exclusive UI file. Empty/validation/success/failure are returned as `validate` field errors and `AdapterSubmitResult` / `AdapterStatusResult` payloads for the conductor-owned credential and status panels.

## Local vs live gates

Local fixtures prove mapping, idempotent submit, recommended document receipt, ownership/purpose/revenue bounds, status/offer/stip mapping. Commercial PEAC sandbox access is not production-verified. Mock/fixture success is not production integration readiness.
