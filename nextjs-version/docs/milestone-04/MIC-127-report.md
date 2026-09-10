# MIC-127 report — Fintegra direct funder API integration

**Status:** DONE locally with synthetic fixtures. Commercial Fintegra sandbox credentials and the current provider endpoint contract remain an external gate.

## Contract

`fintegraAdapter` implements `FunderAdapter` with slug `fintegra`. Capabilities are honest: `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: false`. There is no `parseWebhook`. `getStatus` never attaches financial terms; status updates do not create priced offers.

`validate` returns field errors for legal name, EIN, business address (street/city/state/ZIP), registered originator email, up to three owners (primary required; each owner needs name, SSN, DOB, ownership percent, and residential city/state/ZIP), signed application, and bank statements. A fourth owner is rejected. Mapped requests store SSN last-4 only.

`submit` is fixture-driven (`job.route.destination` or a test override) and idempotent on `job.attemptKey`. Timeouts, expired credentials, disregarded-email, validation failures, and accepted receipts reuse the first correlation id and external reference. Disregarded-email is a distinct `disregarded_email` error, not a generic rejection.

Status mapping from the public guide: New Submission / Received / Work In Process / Underwriting / Clarification Received / Processed → `submitted`; Awaiting Clarification → `pending`; Rejected (and variants) / Cancelled / Disregarded Email → `declined`. Unknown raw values stay `unknown: true` with the original string.

Production vs development credential slots are MIC-124. This adapter reads `adapterRuntime()` when `submitViaAdapter` injects it and otherwise uses fixtures. No MCA Pilot endpoints, IPs, or sample credentials are embedded.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/fintegra.test.ts
```

5/5 passed.

Covered: required-field rejection (including originator email and owner address); three-owner cap; accepted submission with signed-application and bank-statement receipt; timeout / expired credential (destination and missing runtime API key) / attemptKey replay without a second external ref; status mapping without terms; capabilities; disregarded-email vs generic Rejected; secrets and full SSN omitted from results.

## Files

- `src/lib/mca/submissions/adapters/fintegra/index.ts`
- `src/lib/mca/submissions/adapters/fintegra/mapping.ts`
- `src/lib/mca/submissions/adapters/fintegra/fixtures.ts`
- `tests/adapters/fintegra.test.ts`
- `docs/milestone-04/MIC-127-report.md`
- `docs/milestone-04/MIC-127-acceptance.md`

Did not edit `registry.ts`, schema, drizzle, or shared mounts.

## Remaining gates

Commercial provider sandbox access, brokerage-registered originator email, and live Fintegra request/response certification. Mock success is not production integration readiness.

## Handoff

Register `fintegraAdapter` (`slug: fintegra`) in `registry.ts`. No exclusive UI. Loading / empty / validation / success / failure are adapter validate+submit+getStatus states; HTTP ACL remains the MIC-124 credential and MIC-113 poll routes.
