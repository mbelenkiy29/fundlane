# MIC-135 report — Plexe adapter

**Status:** DONE locally with synthetic fixtures. Commercial Plexe sandbox access remains an external gate.

## Contract

`plexeAdapter` (`slug: plexe`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest to the public guide (application ID, bank-statement upload, status retrieval): `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: false`. There is no `parseWebhook`. Status is persisted as raw provider status plus a normalized outcome; financial terms are never invented. Unsupported or unknown outcomes stay visible as raw status for email/manual review.

`validate` requires business name and ZIP, the single highest-ownership owner (name, residential street/city/state, date of birth, email, phone), and annual revenue or statement deposit totals so monthly revenue can be calculated. Amount requested defaults to 2× monthly revenue and purpose of funds defaults to `Working Capital`; those inferred values are previewed in field errors and require `confirmInferredAmount` / `confirmInferredPurpose` or `confirmInferredTerms` before submit. Explicit amount and purpose skip confirmation. Only the highest-ownership owner is mapped (primary is a tie-breaker). Optional EIN, DBA, industry, NAICS, start date, legal structure, website, FICO, and average monthly deposits are passed through when present; SSN is stored as last four only.

`submit(job)` is fixture-backed (keyed by `job.route.destination` or `setPlexeFixture`) and idempotent on `job.attemptKey`. Success returns durable Application ID `plexe_<attemptKey>` and raw status `Sent`. Timeouts reserve that Application ID and recover on replay. Expired credentials do not mint a new reference. Replay of a completed attempt returns the original `externalRef` and statement receipt ids. Only `statement` / `bank_statement` documents are uploaded; application and other package files are not receipted.

`getStatus` maps documented `Sent` to `submitted`. Conservative retrieval outcomes (`In Review` → pending, `Approved` / `Declined` / `Funded`) have no offer terms. Unknown raw values stay `unknown`. Expired credentials fail closed with 503 `provider_unavailable`.

Secrets and owner SSNs are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints, or embed sample provider credentials. Production vs development slots remain MIC-124.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/plexe.test.ts
```

5/5 passed.

Covered: required-field rejection (highest owner, ZIP, revenue or deposits, inferred amount/purpose confirmation); accepted Application ID with highest owner and inferred 2× monthly / Working Capital; statement receipts stable on replay (application docs excluded); timeout then recover without a second Application ID; expired credential without a new submission; status retrieval without invented offers.

## Files

- `src/lib/mca/submissions/adapters/plexe/index.ts`
- `src/lib/mca/submissions/adapters/plexe/mapping.ts`
- `src/lib/mca/submissions/adapters/plexe/fixtures.ts`
- `tests/adapters/plexe.test.ts`
- `docs/milestone-04/MIC-135-report.md`
- `docs/milestone-04/MIC-135-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current Plexe request/response contract tests, and documented certification. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed.

## Handoff

Conductor should `registerAdapter(plexeAdapter)` in `registry.ts` after review.
