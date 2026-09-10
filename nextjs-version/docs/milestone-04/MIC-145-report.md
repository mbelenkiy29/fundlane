# MIC-145 report — Credibly adapter

**Status:** DONE locally with synthetic fixtures. Commercial Credibly sandbox access remains an external gate.

## Contract

`crediblyAdapter` (`slug: credibly`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest to Linear MIC-145 (v2 application/files and Loan ID; Prequalified does not include offer terms): `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: false`. There is no `parseWebhook`. Status is persisted as raw provider status plus a normalized outcome. Financial terms are never attached. Unsupported raw values stay `unknown` for email/manual review.

`validate` requires business identity (name, address, phone, 9-digit EIN, industry, entity type, start date), at least one owner (name, home address, phone, email, date of birth, 9-digit SSN, ownership percent), available positions as an array (empty means none), an application file, and bank statements. Incomplete position rows fail with field errors. Mapped owners store SSN last-4 only.

`submit(job)` is fixture-backed (`job.route.destination` or `setCrediblyFixture`) and idempotent on `job.attemptKey`. Success stores Loan ID `crd_${attemptKey}` and a synthetic portal URL (`portal.example.test` only). Timeouts reserve that Loan ID and recover on replay. Expired credentials do not mint a new Loan ID. Replay of a completed attempt returns the original Loan ID, portal URL, and document receipt ids. Application / `api_application` and statement files map to application and bank-statement receipts.

`getStatus` maps Submitted / New Submission / Received / Sent / In Review / Underwriting → `submitted`; Prequalified → `pending` with no terms; Offers Ready → `approved` with no terms (do not auto-create priced offers from Prequalified or Offers Ready); Declined / Decline / Rejected → `declined`; Funded → `funded`; outstanding document requests → `pending`. Unknown raw stays visible with `unknown: true` and no terms. Expired credentials fail closed with 503 `provider_unavailable`.

Secrets and owner SSNs are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints, or embed sample provider credentials. API key is read from `adapterRuntime()` when `submitViaAdapter` injects it. Production vs development slots remain MIC-124.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/credibly.test.ts
```

5/5 passed.

Covered: required-field rejection (industry, owner address, application/statement files, available positions, invalid EIN/SSN); accepted Loan ID with v2 mapping, positions, portal URL, and status-only flags without inventing terms; document receipts stable on replay; timeout then recover without a second Loan ID; expired credential without a new submission; Prequalified / Offers Ready without priced offers; declines; outstanding documents → pending; unpublished statuses preserved as unknown.

## Files

- `src/lib/mca/submissions/adapters/credibly/index.ts`
- `src/lib/mca/submissions/adapters/credibly/mapping.ts`
- `src/lib/mca/submissions/adapters/credibly/fixtures.ts`
- `tests/adapters/credibly.test.ts`
- `docs/milestone-04/MIC-145-report.md`
- `docs/milestone-04/MIC-145-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current Credibly v2 request/response contract tests, product codes, document transport, and documented certification. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed. The public guide describes Offers Ready creating priced offers; this ticket keeps `offers: false` and does not invent terms from Prequalified or Offers Ready.

## Handoff

Conductor should `registerAdapter(crediblyAdapter)` in `registry.ts` after review. Route destination `credibly`. Status poll only; do not enable webhooks or API offer rows for this slug. Fallback statuses remain raw/unknown for email/manual review.
