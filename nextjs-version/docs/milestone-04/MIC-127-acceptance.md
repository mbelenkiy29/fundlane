# MIC-127 acceptance — Fintegra direct funder API integration

Executed September 8, 2026. Scope: Fintegra `FunderAdapter` with synthetic fixtures for required-field rejection, accepted submission, document receipt, timeout / expired credential / attemptKey replay, status poll without priced offers, three-owner mapping, and registered originator email (including disregarded-email). Live Fintegra APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Passed | `tests/adapters/fintegra.test.ts` — empty `validate` returns legalName, EIN, address, originatorEmail, owners, signed application, and bank statements; incomplete primary owner returns SSN/DOB/percent/address errors; `missing_fields` submit is `validation_failed` with no external ref |
| Up to three owners and originator email | Passed | Three-owner payload maps; fourth owner `Fintegra accepts at most three owners.`; invalid originator email is a field error; mapped request keeps SSN last-4 only |
| Accepted submission and document receipt | Passed | Submit returns `ok`, `externalRef` `ftg-attempt-fintegra-1`, raw `Received`, `signedApplication`/`bankStatements` `received`; job without application+statement documents is `validation_failed` |
| Timeout / expired credential / replay | Passed | Timeout keeps `ftg-attempt-timeout` and the same correlation id on replay; destination `fintegra-expired` and missing runtime API key are `credential_expired` without a new ref; accepted replay reuses the same external ref |
| Status without offers | Passed | Received/Work In Process/… → `submitted`; Awaiting Clarification → `pending`; Rejected variants/Cancelled/Disregarded Email → `declined`; unknown raw preserved; `terms` always absent |
| Disregarded-email distinct | Passed | Submit `errorCode: disregarded_email` with originatorEmail field error; status raw `Disregarded Email` / `declined`; generic `Rejected` is a different raw value |
| Capability flags | Passed | `{ submit: true, statusPoll: true, webhooks: false, offers: false }`; `getStatus` present; `parseWebhook` omitted |
| Loading / empty / validation / success / failure; identity preserved | Passed | Empty validate; field-error submit; accepted submit; timeout and expired failures; retries of the same `attemptKey` keep correlation id and external ref |
| Secrets and document contents omitted | Passed | Results omit API key `ftg-live-secret-never-leak`, full SSN, and document bytes (checksum/category only) |
| Direct API matches UI permissions | N/A in adapter files | No exclusive HTTP. MIC-124/MIC-113 enforce `deals:write` submit/status and admin credentials; this adapter does not add routes |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/fintegra.test.ts
```

5/5 passed.

## Behavior

- Typed application mapping in `mapping.ts` (business, ≤3 owners, originator email, application + statement documents). Live field names and product codes are a provider-access gate.
- Fixtures in `fixtures.ts` keyed by `job.route.destination` or `setFintegraFixtureForTests`. First receipt per `attemptKey` wins.
- `getStatus` persists raw provider status, maps the documented Fintegra outcomes, and never returns `terms` (`offers: false`).
- Runtime API key from `adapterRuntime()` when MIC-124 injects credentials; missing/expired key is `credential_expired`.

## UI

No exclusive UI file. Empty/validation/success/failure are returned as `validate` field errors and `AdapterSubmitResult` / `AdapterStatusResult` payloads for the conductor-owned credential and status panels.

## Local vs live gates

Local fixtures prove mapping, idempotent submit, document receipt, disregarded-email, and status-without-offers. Commercial Fintegra sandbox access is not production-verified. Mock/fixture success is not production integration readiness.
