# MIC-131 report — Forward Financing adapter

**Status:** DONE locally with synthetic fixtures. Commercial Forward Financing sandbox credentials remain an external gate.

## Contract

`forwardFinancingAdapter` (`slug: forward-financing`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest: `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: false`. There is no `parseWebhook`. The public guide documents application/docs with approvals, offers, and declines; this adapter persists those raw outcomes and maps them, but it does not advertise `offers` because no priced term schema (amount/rate/term) is available from public materials. Approval and "Offered" normalize to `approved` with no `terms`. Priced offers stay email/manual review.

`validate` requires business identity (name, address, phone, 9-digit EIN, entity type, start date) and a discrete industry picklist value (Restaurants, Retail, Construction, Transportation, Healthcare, Professional Services, Automotive, Beauty, Manufacturing, Wholesale, Other, plus common aliases). Unmapped industry is a field error. Up to two owners are selected by ownership percentage (then primary, then original order). Each submitted owner needs name, 9-digit SSN, and percentage. Mapped owners store SSN last four only.

`submit(job)` is fixture-backed (keyed by `job.route.destination` or `setForwardFinancingFixture`) and idempotent on `job.attemptKey`. Timeouts reserve the external reference and recover on replay. Expired credentials do not mint a new reference. Replay of a completed attempt returns the original `externalRef` and document receipt ids. Document categories `application` / `api_application`, `statement`, and `voided_check` become receipts. Missing-info maps separately to `pending` with outstanding bank statements and voided check; the same `attemptKey` can attach those documents post-submit. Status is not treated as ready until outstanding requests are covered.

Secrets and owner SSNs are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints, or embed sample provider credentials. Production vs development slots remain MIC-124.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/forward-financing.test.ts
```

5/5 passed.

Covered: required-field rejection (including unmapped industry); accepted submission with two owners by percentage, S-Corporation and Restaurants mapping, status-only capabilities; document receipts stable on replay; timeout then recover without a second external ref; expired credential without a new submission; missing-info → pending until bank statements and voided check are received; Approved / Offered / Declined / unknown mapping with no terms.

## Files

- `src/lib/mca/submissions/adapters/forward-financing/index.ts`
- `src/lib/mca/submissions/adapters/forward-financing/mapping.ts`
- `src/lib/mca/submissions/adapters/forward-financing/fixtures.ts`
- `tests/adapters/forward-financing.test.ts`
- `docs/milestone-04/MIC-131-report.md`
- `docs/milestone-04/MIC-131-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current Forward Financing request/response contract tests, product codes, and documented certification. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed.

## Handoff

Conductor should `registerAdapter(forwardFinancingAdapter)` in `registry.ts` after review. Route destination `forward-financing`. Status poll only; do not enable webhooks or API offer rows for this slug.
