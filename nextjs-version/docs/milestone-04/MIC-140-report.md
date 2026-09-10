# MIC-140 report — Bitty Advance adapter

**Status:** DONE locally with synthetic fixtures. Commercial Bitty Advance sandbox access remains an external gate.

## Contract

`bittyAdvanceAdapter` (`slug: bitty-advance`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest to the public guide (deal/files submission, offers, declines, portal link, and status retrieval): `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: true`. There is no `parseWebhook`. Status is persisted as raw provider status plus a normalized outcome. Unsupported raw values stay `unknown` for email/manual review. Financial terms are returned only for the documented offer fixture.

`validate` requires business identity (name, address, phone, 9-digit EIN, industry, entity type), at least one owner (name, home address, phone, email, date of birth, 9-digit SSN, ownership percent), and at least one statement with both revenue and negative days. Zero negative days is a valid value; missing or unknown metrics are not. Application and bank-statement files are recommended in the public guide and are receipted when present, but they are not required to validate or submit.

`submit(job)` is fixture-backed (`job.route.destination` or `setBittyAdvanceFixture`) and idempotent on `job.attemptKey`. Success stores Deal ID `bitty_${attemptKey}` and a synthetic portal URL (`portal.example.test` only). Timeouts reserve that Deal ID and recover on replay. Expired credentials do not mint a new Deal ID. Replay of a completed attempt returns the original Deal ID, portal URL, and document receipt ids.

`getStatus` maps documented outcome buckets: Submitted / Received / Sent / New Submission → `submitted`; Offer / Offered / Approved → `approved`; Declined / Decline / Rejected → `declined`. Hold and other unpublished values stay `unknown` with the original raw string. Offer terms (including a synthetic offer link) attach only to the offer fixture. Submitted acknowledgements do not invent terms. Expired credentials fail closed with 503 `provider_unavailable`.

Secrets and owner SSNs are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints, or embed sample provider credentials. API key is read from `adapterRuntime()` when `submitViaAdapter` injects it. Production vs development slots remain MIC-124.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/bitty-advance.test.ts
```

5/5 passed.

Covered: required-field rejection (business, owner, statement revenue and negative days, including unknown MetricEvidence); accepted Deal ID with portal URL and offer-capable flags without inventing terms on Submitted; document receipts stable on replay (files optional); timeout then recover without a second Deal ID; expired credential without a new submission; submitted/offer/declined mapping; Hold/Funded/unpublished statuses preserved as unknown.

## Files

- `src/lib/mca/submissions/adapters/bitty-advance/index.ts`
- `src/lib/mca/submissions/adapters/bitty-advance/mapping.ts`
- `src/lib/mca/submissions/adapters/bitty-advance/fixtures.ts`
- `tests/adapters/bitty-advance.test.ts`
- `docs/milestone-04/MIC-140-report.md`
- `docs/milestone-04/MIC-140-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current Bitty Advance request/response contract tests, product codes, and documented certification. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed.

## Handoff

Conductor should `registerAdapter(bittyAdvanceAdapter)` in `registry.ts` after review. Route destination `bitty-advance`. Status poll and offer reconciliation can consume `getStatus`; do not enable webhooks for this slug. Fallback statuses remain raw/unknown for email/manual review.
