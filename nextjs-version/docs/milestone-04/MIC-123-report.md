# MIC-123 report — Expansion Capital Group adapter

**Status:** DONE locally with synthetic fixtures. Commercial Expansion Capital Group sandbox access remains an external gate.

## Contract

`expansionCapitalGroupAdapter` (`slug: expansion-capital-group`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest: `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: false`. There is no `parseWebhook`. Status and missing-info are persisted as raw provider status plus a normalized outcome; financial terms are never invented.

`validate` requires business identity (name, DBA, address, phone, 9-digit EIN, industry, entity type, start date), registered partner email + representative name, and up to two owners ordered by ownership percentage (then primary, then original order). Each submitted owner needs name, address, phone, email, date of birth, 9-digit SSN, and percentage. Unregistered partner email is a field error. Entity types map to LLC / Corporation / Partnership / Sole Proprietor, else Other. Landlord fields are present and blank.

`submit(job)` is fixture-backed (keyed by `job.route.destination` or `setExpansionCapitalGroupFixture`) and idempotent on `job.attemptKey`. Timeouts reserve the external reference and recover on replay. Expired credentials do not mint a new reference. Replay of a completed attempt returns the original `externalRef` and document receipt ids. Document categories `application` / `api_application` and `statement` map to application and bank-statement receipts. Outstanding document requests map to `pending` with the requested items in `rawStatus`.

Secrets and owner SSNs are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints, or embed sample provider credentials. Production vs development slots remain MIC-124.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/expansion-capital-group.test.ts
```

5/5 passed.

Covered: required-field rejection (including unregistered partner); accepted submission with two owners by percentage, Corporation mapping, status-only capabilities; document receipts stable on replay; timeout then recover without a second external ref; expired credential without a new submission; outstanding document requests → pending.

## Files

- `src/lib/mca/submissions/adapters/expansion-capital-group/index.ts`
- `src/lib/mca/submissions/adapters/expansion-capital-group/mapping.ts`
- `src/lib/mca/submissions/adapters/expansion-capital-group/fixtures.ts`
- `tests/adapters/expansion-capital-group.test.ts`
- `docs/milestone-04/MIC-123-report.md`
- `docs/milestone-04/MIC-123-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current Expansion request/response contract tests, and documented certification. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed.

## Handoff

Conductor should `registerAdapter(expansionCapitalGroupAdapter)` in `registry.ts` after review. Remaining adapters can copy this folder shape (`index` / `mapping` / `fixtures`) with slug-specific maps.
