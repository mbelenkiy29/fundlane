# MIC-141 report — Lendini adapter

**Status:** DONE locally with synthetic fixtures. Commercial Lendini (Funding Metrics) sandbox access remains an external gate.

## Contract

`lendiniAdapter` (`slug: lendini`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest to the public guide (asynchronous deal/document submission, live status checks, declines, and offers): `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: true`. There is no `parseWebhook`. Status is persisted as raw provider status plus a normalized outcome. Financial terms are returned only for the documented offer fixture. Unsupported raw values stay `unknown` for email/manual review.

`validate` requires complete business identity (name, address, phone, 9-digit EIN, industry, entity type, inception date) and the single highest-ownership owner (name, home address, phone, email, date of birth, 9-digit SSN, ownership percent). Secondary owners are not submitted and are not required to be complete. Application and bank-statement files are recommended in the public guide and are receipted when present, but they are not required to validate or submit.

`submit(job)` is fixture-backed (`job.route.destination` or `setLendiniFixture`) and idempotent on `job.attemptKey`. Success stores application id `lendini_${attemptKey}` and always retains the initial acknowledgement `Received`. Industry names are formatted (aliases plus title case); legal structures map to Lendini entity types (`LLC`, `Corp`, `Partnership`, `Sole Proprietor`, `Other`). Timeouts reserve that application id and recover on replay. Expired credentials do not mint a new reference. Replay of a completed attempt returns the original application id, acknowledgement, and document receipt ids.

`getStatus` polls the later decision while the submit acknowledgement stays `Received`. Documented buckets: Received / Submitted / Acknowledged / Processing / New Submission → `submitted`; Offer / Offered / Approved → `approved`; Declined / Decline / Rejected → `declined`. Hold, Funded, and other unpublished values stay `unknown` with the original raw string. Offer terms (including a synthetic offer link) attach only to the offer fixture. Submitted acknowledgements and declines do not invent amounts. Expired credentials fail closed with 503 `provider_unavailable`.

Secrets and owner SSNs are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints, or embed sample provider credentials. API key is read from `adapterRuntime()` when `submitViaAdapter` injects it. Production vs development slots remain MIC-124.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/lendini.test.ts
```

5/5 passed.

Covered: required-field rejection (business, inception date, highest-ownership owner only); accepted application id with one owner, `s_corporation` → `Corp`, `restaurant` → `Food Services`, and `Received` acknowledgement without inventing terms; document receipts stable on replay (files optional); timeout then recover without a second application id; expired credential without a new submission; offer/decline retrieved by status poll while submit retains `Received`; Hold/Funded/unpublished statuses preserved as unknown.

## Files

- `src/lib/mca/submissions/adapters/lendini/index.ts`
- `src/lib/mca/submissions/adapters/lendini/mapping.ts`
- `src/lib/mca/submissions/adapters/lendini/fixtures.ts`
- `tests/adapters/lendini.test.ts`
- `docs/milestone-04/MIC-141-report.md`
- `docs/milestone-04/MIC-141-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current Lendini request/response contract tests, product codes, document transport, and documented certification after a development test deal. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed. Lendini does not publish the industry picklist or exact status vocabulary in the public guide; formatting and status buckets are derived from that guide plus honest unknown fallbacks.

## Handoff

Conductor should `registerAdapter(lendiniAdapter)` in `registry.ts` after review. Route destination `lendini`. Status poll and offer reconciliation can consume `getStatus`; do not enable webhooks for this slug. Fallback statuses remain raw/unknown for email/manual review.
