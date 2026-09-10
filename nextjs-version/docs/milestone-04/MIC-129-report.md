# MIC-129 report — Quantum Lends adapter

**Status:** DONE locally with synthetic fixtures. Commercial Quantum Lends sandbox credentials and the current provider HTTP contract remain an external gate.

## Contract

`quantumLendsAdapter` implements `FunderAdapter` at slug `quantum-lends`. Capabilities are honest: `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: false`. `getStatus` is implemented; `parseWebhook` is omitted.

`validate` maps a merchant application to field errors. Required fields include legal name, address, phone, entity type, start date, owners (name, ownership, SSN last four), requested amount, and annual revenue (explicit or `monthlyRevenue * 12`). EIN is required except for sole proprietors. The highest-ownership owner is marked primary. Industries map to NAICS locally; an unmapped industry without a NAICS code is a field error. Full SSNs are reduced to last four and never returned.

`submit(job)` does not call a live API. Fixtures are keyed by `job.route.destination` (`quantum-lends`, `quantum-lends:timeout`, `quantum-lends:expired`, …) or `setQuantumLendsFixtureForTests`. Success is idempotent on `job.attemptKey` and reuses `ql-<attemptKey>`. Timeouts and expired credentials return actionable errors without an external ref. Statement `documentVersions` produce a document-receipt field set; bytes and checksums are not echoed.

`getStatus` maps provider raw values Sent / Approved / Funded / Declined to `submitted` / `approved` / `funded` / `declined`. Other raw values stay `unknown: true` with the original string. No offer terms are returned.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/quantum-lends.test.ts
```

6/6 passed.

Covered: capability flags; empty/required-field rejection including requested amount and annual revenue; sole-proprietor EIN exception; highest-ownership primary applicant; NAICS mapping; accepted submit with statement document receipt; timeout and expired credentials without duplicate refs; attemptKey replay; sent/approved/funded/declined/unknown status; secrets and full SSN omitted.

## Files

- `src/lib/mca/submissions/adapters/quantum-lends/index.ts`
- `src/lib/mca/submissions/adapters/quantum-lends/mapping.ts`
- `src/lib/mca/submissions/adapters/quantum-lends/fixtures.ts`
- `tests/adapters/quantum-lends.test.ts`
- `docs/milestone-04/MIC-129-report.md`
- `docs/milestone-04/MIC-129-acceptance.md`

Did not edit `registry.ts`. Conductor registers the slug after review.

## Remaining gates

Commercial provider sandbox access, brokerage-specific credentials, and contract tests against the live Quantum Lends request/response schema. Fixture success is not production integration readiness.

## Handoff

`registerAdapter(quantumLendsAdapter)` in `registry.ts`. Route destination `quantum-lends`. Status poll only; no webhook ingest and no API offer rows.
