# MIC-139 report — CAN Capital adapter

**Status:** DONE locally with synthetic fixtures. Commercial CAN Capital sandbox access remains an external gate.

## Contract

`canCapitalAdapter` (`slug: can-capital`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest to the public guide (application/docs plus live status checks): `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: false`. There is no `parseWebhook`. Status is persisted as raw provider status plus a normalized outcome; financial terms are never invented. Unknown raw values stay `unknown: true` for email/manual review.

Credentials are six named components, not a comma-joined blob: consumer key (`clientId`), client secret (`clientSecret`), unique general email (`username`), unique general password (`password`), unique partner API key (`apiKey`), and sales-rep email (application `salesRepEmail` when present). Production vs development slots remain MIC-124; this adapter reads `adapterRuntime()` when `submitViaAdapter` injects it.

`validate` requires complete business identity (name, DBA, address, 10-digit phone, 9-digit EIN, industry, entity type, inception date, funding amount) and the single primary owner by highest ownership percentage (name, address, 10-digit phone, email, 9-digit SSN, date of birth, 18+). State of formation (2-letter) is required for Corporation, Partnership, LLC, LLP, and Limited Partnership, including S-corporation mapped to Corporation. Sole proprietor does not require formation. Only the primary owner is mapped.

`submit(job)` is fixture-backed (keyed by `job.route.destination` or `setCanCapitalFixture`) and idempotent on `job.attemptKey`. Success returns durable Application Name `can_<attemptKey>` and raw status `Application Received`. Timeouts reserve that name and recover on replay. Expired credentials (any structured component) do not mint a new reference. Replay of a completed attempt returns the original `externalRef` and document receipt ids. Document categories `application` / `api_application` and `statement` map to application and bank-statement receipts.

`getStatus` maps Application Received / Submitted / New Submission → `submitted`; In Review / Pending / Missing Information → `pending`; outstanding document requests → `pending` with the requested items in `rawStatus`; Approved → `approved`; Declined / Rejected → `declined`; Funded → `funded`. Unknown raw stays visible with `unknown: true` and no terms.

Secrets and owner SSNs are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints, or embed sample provider credentials.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/can-capital.test.ts
```

5/5 passed.

Covered: required-field rejection (LLC/Corporation formation, underage owner, 10-digit phones); accepted Application Name with primary owner, structured credential mapping, status-only capabilities; document receipts stable on replay; timeout then recover without a second Application Name; expired credential without a new submission; outstanding documents → pending; unknown raw stays unknown with no offers.

## Files

- `src/lib/mca/submissions/adapters/can-capital/index.ts`
- `src/lib/mca/submissions/adapters/can-capital/mapping.ts`
- `src/lib/mca/submissions/adapters/can-capital/fixtures.ts`
- `tests/adapters/can-capital.test.ts`
- `docs/milestone-04/MIC-139-report.md`
- `docs/milestone-04/MIC-139-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current CAN Capital request/response contract tests, product codes, document transport certification, and documented provider approval. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed.

## Handoff

Conductor should `registerAdapter(canCapitalAdapter)` in `registry.ts` after review. Route destination `can-capital`. Status poll only; do not enable webhooks or API offer rows for this slug.
