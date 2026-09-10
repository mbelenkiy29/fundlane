# MIC-137 report — Idea Financial adapter

**Status:** DONE locally with synthetic fixtures. Commercial Idea Financial sandbox access remains an external gate.

## Contract

`ideaFinancialAdapter` (`slug: idea-financial`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest to the public guide (all-owner submission, status, offers, checkout links, and stips): `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: true`. There is no `parseWebhook`. Status is persisted as raw provider status plus a normalized outcome. Offer terms (amount, rate, term, frequency, checkout `offerLink`) are attached only for approved/funded fixtures; stips stay visible on `rawStatus`. Unknown raw values stay `unknown: true` with the original string for email/manual review.

`validate` requires business identity (name, legal structure, address, phone, 9-digit EIN), all owners (name, residential address, email, phone, date of birth, 9-digit SSN, ownership percent), originator mobile phone with submitter fallback, and monthly revenue derived from annual revenue or statement deposits. Amount requested defaults to 2× monthly revenue (or $25,000 if revenue is unavailable). FICO defaults to 650 and NAICS to `999999`. Application and bank-statement files are recommended, not required.

`submit(job)` is fixture-backed (keyed by `job.route.destination` or `setIdeaFinancialFixture`) and idempotent on `job.attemptKey`. Success returns Application Number `idea_<attemptKey>` and raw status `Processing`. Timeouts reserve that Application Number and recover on replay. Expired username/password/client credentials do not mint a new reference. Replay of a completed attempt returns the original `externalRef` and document receipt ids. All owners are mapped (no highest-owner cap).

`getStatus` maps the public guide: Draft / Processing → `submitted`; Submission Incomplete / Dormant → `pending`; Conditional Offer / Offer / Closing / Contract Ready / Contract Out / Closing Incomplete → `approved`; Funded / Closed / Open → `funded`; Declined / Not Interested / Abandoned → `declined`. Outstanding document requests map to `pending`. Expired credentials fail closed with 503 `provider_unavailable`.

Secrets and owner SSNs are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints, or embed sample provider credentials. Structured `username` / `password` / `clientId` / `clientSecret` are read from `adapterRuntime()` when `submitViaAdapter` injects them. Production vs development slots remain MIC-124.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/idea-financial.test.ts
```

5/5 passed.

Covered: required-field rejection (business, 9-digit EIN, originator phone, all-owner fields, revenue derivation) with submitter-phone fallback and deposit-derived monthly revenue; accepted Application Number with all three owners, annual→monthly 60000, inferred 2× amount, FICO/NAICS defaults; document receipts stable on replay; timeout then recover without a second Application Number; expired credential without a new submission; status/offer/link/stip mapping without inventing terms on Processing.

## Files

- `src/lib/mca/submissions/adapters/idea-financial/index.ts`
- `src/lib/mca/submissions/adapters/idea-financial/mapping.ts`
- `src/lib/mca/submissions/adapters/idea-financial/fixtures.ts`
- `tests/adapters/idea-financial.test.ts`
- `docs/milestone-04/MIC-137-report.md`
- `docs/milestone-04/MIC-137-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current Idea Financial request/response contract tests, mandatory product codes, document transport certification, and documented production enablement after development testing. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed.

## Handoff

Conductor should `registerAdapter(ideaFinancialAdapter)` in `registry.ts` after review. Route destination should be `idea-financial`. Status poll + offer reconciliation can consume `getStatus`; do not enable webhooks for this slug.
