# MIC-143 report — Everest Business Funding adapter

**Status:** DONE locally with synthetic fixtures. Commercial Everest Business Funding sandbox access remains an external gate.

## Contract

`everestBusinessFundingAdapter` (`slug: everest-business-funding`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest to the public guide (deal/files submission, offers, declines, and status checks): `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: true`. There is no `parseWebhook`. Status is persisted as raw provider status plus a normalized outcome. Unsupported raw values stay `unknown` for email/manual review. Financial terms are returned only for the documented offer fixture.

Credentials are structured client ID (`clientId`) and client secret (`clientSecret`) fields. The adapter does not parse a comma-joined API key blob. Production vs development slots remain MIC-124; this adapter reads `adapterRuntime()` when `submitViaAdapter` injects it.

`validate` requires business name, a 9-digit EIN, an API application file, and distinct bank-statement files. The same document id cannot satisfy both file roles. Owners, address, phone, and other identity fields are optional because they are not in the public required set.

`submit(job)` is fixture-backed (`job.route.destination` or `setEverestBusinessFundingFixture`) and idempotent on `job.attemptKey`. Success stores Deal ID `ebf_${attemptKey}`. Timeouts reserve that Deal ID and recover on replay. Expired credentials do not mint a new Deal ID. Replay of a completed attempt returns the original Deal ID and document receipt ids. Missing required files fail closed without an external ref, except timeout and expired-credential fixtures.

`getStatus` maps documented outcome buckets: Submitted / Received / Sent / New Submission → `submitted`; Offer / Offered / Approved → `approved`; Declined / Decline / Rejected → `declined`. Hold, Funded, and other unpublished values stay `unknown` with the original raw string. Offer terms (including a synthetic offer link on `offers.example.test`) attach only to the offer fixture. Submitted acknowledgements and declines do not invent terms. Expired credentials fail closed with 503 `provider_unavailable`.

Secrets are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints, or embed sample provider credentials.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/everest-business-funding.test.ts
```

5/5 passed.

Covered: required-field rejection (business name, EIN, distinct API application and statement files); accepted Deal ID with structured client ID/secret mapping and offer-capable flags without inventing terms on Submitted; document receipts stable on replay; timeout then recover without a second Deal ID; expired credential without a new submission; submitted/offer/declined mapping; Hold/Funded/unpublished statuses preserved as unknown.

## Files

- `src/lib/mca/submissions/adapters/everest-business-funding/index.ts`
- `src/lib/mca/submissions/adapters/everest-business-funding/mapping.ts`
- `src/lib/mca/submissions/adapters/everest-business-funding/fixtures.ts`
- `tests/adapters/everest-business-funding.test.ts`
- `docs/milestone-04/MIC-143-report.md`
- `docs/milestone-04/MIC-143-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current Everest request/response contract tests, product codes, document transport, and documented certification. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed.

## Handoff

Conductor should `registerAdapter(everestBusinessFundingAdapter)` in `registry.ts` after review. Route destination `everest-business-funding`. Status poll and offer reconciliation can consume `getStatus`; do not enable webhooks for this slug. Fallback statuses remain raw/unknown for email/manual review.
