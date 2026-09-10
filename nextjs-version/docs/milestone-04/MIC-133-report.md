# MIC-133 report — Rapid Finance adapter

**Status:** DONE locally with synthetic fixtures. Commercial Rapid Finance sandbox access remains an external gate.

## Contract

`rapidFinanceAdapter` (`slug: rapid-finance`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest: `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: true`. There is no `parseWebhook`. The public guide documents Deal ID, status, offers, and portal navigation; webhooks are not advertised.

`validate` requires business identity (name, address, phone, business email, 9-digit EIN, industry, entity type), annual revenue (`annualRevenue`, `grossAnnualRevenue`, or `monthlyRevenue * 12`), at least one owner (name, home address, phone, email, date of birth, 9-digit SSN, ownership percent), a signed application file, and bank statements.

`submit(job)` is fixture-backed (`job.route.destination` or `setRapidFinanceFixture`) and idempotent on `job.attemptKey`. A successful acknowledgement stores Deal ID `rf_${attemptKey}` and a synthetic portal URL. Timeouts reserve that Deal ID and recover on replay. Expired credentials do not mint a new Deal ID. Replay of a completed attempt returns the original Deal ID, portal URL, and document receipt ids. Application / `api_application` and statement files map to application and bank-statement receipts.

`getStatus` maps public-guide buckets: SENT / InProgress / SubmittedDeal → `submitted`; ConditionallySubmitted / Pending → `pending`; Approved / ApprovedWithStips / Quoted / PrequalPass → `approved`; Declined / PreQualFail / Unqualified_WillingReconsiderLater / Rejected → `declined`; Funded → `funded`. Withdrawn, ContractsOut, RescindByClient, and RescindByRapidFinance stay `unknown` with the original raw value so they can route to email/manual review. Offer terms are returned only for approved/funded fixtures that include them.

Secrets and owner SSNs are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints, or embed sample provider credentials. Production vs development slots remain MIC-124.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/rapid-finance.test.ts
```

5/5 passed.

Covered: required-field rejection (annual revenue, owner identity, application and bank files); accepted submission with Deal ID, portal URL, and offer-capable flags without inventing terms on SENT; document receipts stable on replay; timeout then recover without a second Deal ID; expired credential without a new submission; sent/pending/approved/declined/funded mapping; withdrawn/rescinded/contracts-out preserved as unknown; offers only when terms exist.

## Files

- `src/lib/mca/submissions/adapters/rapid-finance/index.ts`
- `src/lib/mca/submissions/adapters/rapid-finance/mapping.ts`
- `src/lib/mca/submissions/adapters/rapid-finance/fixtures.ts`
- `tests/adapters/rapid-finance.test.ts`
- `docs/milestone-04/MIC-133-report.md`
- `docs/milestone-04/MIC-133-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current Rapid Finance request/response contract tests, product codes, and documented certification. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed.

## Handoff

Conductor should `registerAdapter(rapidFinanceAdapter)` in `registry.ts` after review. Route destination `rapid-finance`. Status poll and offer reconciliation can consume `getStatus`; do not enable webhooks for this slug. Fallback statuses remain raw/unknown for email/manual review.
