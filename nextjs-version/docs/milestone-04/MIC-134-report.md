# MIC-134 report — Headway Capital adapter

**Status:** DONE locally with synthetic fixtures. Commercial Headway Capital sandbox access remains an external gate.

## Contract

`headwayCapitalAdapter` (`slug: headway-capital`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest: `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: true`. There is no `parseWebhook`. The public guide documents application documents, underwriting, Account ID, offers, and declines; webhooks are not documented.

`validate` requires business identity (name, address, phone, 9-digit EIN, industry, entity type, start date, email), at least one owner (name, SSN, date of birth, phone, home address, email), financials (annual revenue, requested loan amount, loan purpose), an application file, and bank statements. Ownership percent is optional; if present it must be 0–100. Owner count is not capped because the public guide does not publish a limit.

`submit(job)` is fixture-backed (keyed by `job.route.destination` or `setHeadwayCapitalFixture`) and idempotent on `job.attemptKey`. A successful default acknowledgement is `In Underwriting` with Account ID `hwc_${attemptKey}` — not approval. Timeouts reserve that Account ID and recover on replay. Expired credentials do not mint a new reference. Replay of a completed attempt returns the original `externalRef` and document receipt ids. Document categories `application` / `api_application` and `statement` map to application and bank-statement receipts.

`getStatus` maps the public guide: Application Incomplete and Action Required → `pending`; In Underwriting → `submitted`; Offer Ready / Contract Unsigned / Funding Pending → `approved`; Issued → `funded`; Declined → `declined`. Synthetic offer terms are attached only for approved/funded offer fixtures. Unknown raw values stay `unknown: true` with the original string. Outstanding document requests map to `pending` with the requested items in `rawStatus`.

Secrets and owner SSNs are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints or IP allowlists, or embed sample provider credentials. Username/password (and optional apiKey) are read from `adapterRuntime()` when `submitViaAdapter` injects them. Production vs development slots remain MIC-124.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/headway-capital.test.ts
```

5/5 passed.

Covered: required-field rejection (business, owner, financials, application file, bank statements); accepted submission with Account ID and underwriting (not approval); document receipts stable on replay; timeout then recover without a second Account ID; expired credential without a new submission; incomplete / action-required / offer-ready / issued / declined mapping; offers only when terms exist; capability flags.

## Files

- `src/lib/mca/submissions/adapters/headway-capital/index.ts`
- `src/lib/mca/submissions/adapters/headway-capital/mapping.ts`
- `src/lib/mca/submissions/adapters/headway-capital/fixtures.ts`
- `tests/adapters/headway-capital.test.ts`
- `docs/milestone-04/MIC-134-report.md`
- `docs/milestone-04/MIC-134-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current Headway request/response contract tests, mandatory product codes, and documented certification. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed.

## Handoff

Conductor should `registerAdapter(headwayCapitalAdapter)` in `registry.ts` after review. Route destination should be `headway-capital`. Status poll + offer reconciliation can consume `getStatus`; do not enable webhooks for this slug.
