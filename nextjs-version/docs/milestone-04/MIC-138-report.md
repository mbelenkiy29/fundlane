# MIC-138 report — PEAC Solutions direct funder API integration

**Status:** DONE locally with synthetic fixtures. Commercial PEAC Solutions sandbox credentials and the current provider endpoint contract remain an external gate.

## Contract

`peacSolutionsAdapter` (`slug: peac-solutions`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest to the public guide (early and later status checks, offer details, offer links, and stips): `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: true`. There is no `parseWebhook`.

`validate` requires legal name, entity type, business address, phone, and business email; purpose of funds; requested amount bounded to the public working-capital max of $250,000; annual revenue or a calculable substitute (monthly revenue × 12, or average statement deposits × 12); and up to three owners (name, home address, phone, email, SSN, date of birth, ownership percent) whose represented ownership totals at least 50%. A fourth owner is rejected. Documents are recommended, not required. Optional EIN, if present, must be 9 digits. Mapped owners store SSN last-4 only.

`submit(job)` is fixture-backed (`job.route.destination` or `setPeacSolutionsFixture`) and idempotent on `job.attemptKey`. Success returns durable external ref `peac_${attemptKey}` and raw `In Process`. Timeouts reserve that ref and recover on replay. Expired credentials do not mint a new reference. Replay of a completed attempt returns the original external ref and document receipt ids. Application / `api_application` and statement files map to application and bank-statement receipts when present.

`getStatus` maps the public guide: In Process → `submitted`; Incomplete (including outstanding stipulations) → `pending`; Booked / Offers Ready / Offers Selected / Contracts Out / Final Diligence / In Pricing / Ready for Funding → `approved`; Funded → `funded`; Withdrawn / No PQ Offers Available → `declined`. Synthetic offer terms and an offer link are attached only for approved/funded offer fixtures. Unknown raw values stay `unknown: true` with the original string for email/manual review.

Secrets and owner SSNs are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints, IPs, or sample credentials. Username/password/apiKey are read from `adapterRuntime()` when `submitViaAdapter` injects them. Production vs development slots remain MIC-124.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/peac-solutions.test.ts
```

5/5 passed.

Covered: required-field rejection (purpose of funds, revenue, owner cap, 50% ownership, $250,000 amount bound); accepted submission with three owners and In Process; recommended document receipts stable on replay (documents optional); timeout then recover without a second external ref; expired credential without a new submission; process/stips/offers/declines mapping; unknown raw preserved; capability flags.

## Files

- `src/lib/mca/submissions/adapters/peac-solutions/index.ts`
- `src/lib/mca/submissions/adapters/peac-solutions/mapping.ts`
- `src/lib/mca/submissions/adapters/peac-solutions/fixtures.ts`
- `tests/adapters/peac-solutions.test.ts`
- `docs/milestone-04/MIC-138-report.md`
- `docs/milestone-04/MIC-138-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, brokerage-specific username/password/partner ID/broker number, current PEAC request/response contract tests, product codes, document transport, and documented certification. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed. The public guide allows calculating amount requested from bank statements; this adapter requires an explicit requested amount because PEAC does not publish that formula.

## Handoff

Conductor should `registerAdapter(peacSolutionsAdapter)` in `registry.ts` after review. Route destination `peac-solutions`. Status poll and offer reconciliation can consume `getStatus`; do not enable webhooks for this slug. Unknown statuses remain raw for email/manual review.
