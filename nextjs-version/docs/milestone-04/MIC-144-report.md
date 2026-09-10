# MIC-144 report — OnDeck adapter

**Status:** DONE locally with synthetic fixtures. Commercial OnDeck sandbox access remains an external gate.

## Contract

`ondeckAdapter` (`slug: ondeck`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest to the public guide (application upload, offers, declines, portal link, and status check): `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: true`. There is no `parseWebhook`. Status is persisted as raw provider status plus a normalized outcome. Unsupported raw values stay `unknown` for email/manual review. Financial terms are returned only for the documented offer fixture.

Credentials are the three MIC-124 named fields (`apiKey`, `username`, `password`), not a comma-joined blob. Production vs development slots remain MIC-124; this adapter reads `adapterRuntime()` when `submitViaAdapter` injects it.

`validate` requires business identity (name, address, phone, 9-digit EIN, industry, entity type), at least one owner (name, home address, phone, email, date of birth, 9-digit SSN, ownership percent), and at least one statement with both revenue and average daily balance. Zero ADB is a valid source value; missing or unknown MetricEvidence is not. Negative source ADB is accepted without rewriting the statement: the outbound payload clamps that ADB to `$0` and keeps the original amount. Application and bank-statement files are recommended in the public guide and are receipted when present, but they are not required to validate or submit.

`submit(job)` is fixture-backed (`job.route.destination` or `setOnDeckFixture`) and idempotent on `job.attemptKey`. Success stores App ID `ondeck_${attemptKey}` and a synthetic portal URL (`portal.example.test` only). Timeouts reserve that App ID and recover on replay. Expired credentials (any of the three secret fields) do not mint a new App ID. Replay of a completed attempt returns the original App ID, portal URL, and document receipt ids.

`getStatus` maps documented outcome buckets: Application Received / Received / Submitted / Sent / New Submission → `submitted`; Offer / Offered / Approved → `approved`; Declined / Decline / Rejected → `declined`. Hold, Funded, and other unpublished values stay `unknown` with the original raw string. Offer terms (including a synthetic offer link) attach only to the offer fixture. Application Received acknowledgements do not invent terms. Expired credentials fail closed with 503 `provider_unavailable`.

Secrets and owner SSNs are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints, or embed sample provider credentials.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/ondeck.test.ts
```

5/5 passed.

Covered: required-field rejection (business, owner phone, statement revenue and average daily balance, including unknown MetricEvidence); negative source ADB preserved with outbound `$0` clamp; accepted App ID with portal URL and offer-capable flags without inventing terms on Application Received; document receipts stable on replay (files optional); timeout then recover without a second App ID; expired credential without a new submission; submitted/offer/declined mapping; Hold/Funded/unpublished statuses preserved as unknown.

## Files

- `src/lib/mca/submissions/adapters/ondeck/index.ts`
- `src/lib/mca/submissions/adapters/ondeck/mapping.ts`
- `src/lib/mca/submissions/adapters/ondeck/fixtures.ts`
- `tests/adapters/ondeck.test.ts`
- `docs/milestone-04/MIC-144-report.md`
- `docs/milestone-04/MIC-144-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current OnDeck request/response contract tests, product codes, document transport, and documented certification. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed.

## Handoff

Conductor should `registerAdapter(ondeckAdapter)` in `registry.ts` after review. Route destination `ondeck`. Status poll and offer reconciliation can consume `getStatus`; do not enable webhooks for this slug. Fallback statuses remain raw/unknown for email/manual review.
