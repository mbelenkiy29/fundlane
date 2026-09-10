# MIC-136 report — Fora Financial adapter

**Status:** DONE locally with synthetic fixtures. Commercial Fora Financial sandbox access remains an external gate.

## Contract

`foraFinancialAdapter` (`slug: fora-financial`) implements `FunderAdapter` with `validate`, `submit`, and `getStatus`. Capabilities are honest to the public guide (deal submit, Check Status / Open in Fora portal action, funding-stage updates): `submit: true`, `statusPoll: true`, `webhooks: false`, `offers: false`. There is no `parseWebhook`. Status is persisted as raw provider status plus a normalized outcome; financial terms are never invented. Unsupported or unknown outcomes stay visible as raw status for email/manual review.

`validate` requires complete business identity (name, DBA, address, phone, 9-digit EIN, industry, entity type, inception date), funding amount, financials from annual revenue, monthly revenue, or statement deposit totals, and the single highest-ownership owner (name, residential address, phone, email, date of birth, SSN, ownership percent). Credit-pull consent must be recorded as granted for both the business and that primary owner; it is never defaulted to true. Industry aliases map to Fora categories with `Other` as the fallback; legal structures map to Fora entity types the same way. Secondary owners are not submitted.

`submit(job)` is fixture-backed (keyed by `job.route.destination` or `setForaFinancialFixture`) and idempotent on `job.attemptKey`. Success returns durable Application ID `fora_<attemptKey>` and raw status `In Progress` (`Incomplete Application` for the incomplete fixture). Timeouts reserve that Application ID and recover on replay. Expired credentials do not mint a new reference. Replay of a completed attempt returns the original `externalRef` and document receipt ids. Recommended application and bank-statement files are receipted; other package files are not.

`getStatus` maps documented funding stages: Incomplete Application → `pending`; In Progress → `submitted`; Approved / Contracts In / Pending Funding → `approved`; Funded → `funded`; Declined → `declined`. No offer terms are attached. Unknown raw values stay `unknown`. Expired credentials fail closed with 503 `provider_unavailable`.

Secrets and owner SSNs are omitted from adapter results. The adapter does not call live HTTP, copy MCA Pilot endpoints, or embed sample provider credentials. Production vs development slots remain MIC-124.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters/fora-financial.test.ts
```

5/5 passed.

Covered: required-field rejection (business, primary owner, funding amount, financials, recorded credit-pull consent; consent is not assumed); accepted Application ID with highest owner Alex at 55%, S-Corporation / Food Services mapping, and granted consent; application + bank-statement receipts stable on replay (other files excluded); timeout then recover without a second Application ID; expired credential without a new submission; funding-stage status without invented offers.

## Files

- `src/lib/mca/submissions/adapters/fora-financial/index.ts`
- `src/lib/mca/submissions/adapters/fora-financial/mapping.ts`
- `src/lib/mca/submissions/adapters/fora-financial/fixtures.ts`
- `tests/adapters/fora-financial.test.ts`
- `docs/milestone-04/MIC-136-report.md`
- `docs/milestone-04/MIC-136-acceptance.md`

Did not edit `registry.ts`, `framework.ts`, `credentials.ts`, schema, or drizzle.

## Remaining gates

Commercial provider sandbox access, current Fora request/response contract tests, documented industry/entity picklists, and documented certification. Mock/fixture success is not production integration readiness. No live merchant submission or provider outreach was performed.

## Handoff

Conductor should `registerAdapter(foraFinancialAdapter)` in `registry.ts` after review. Route destination should be `fora-financial`. Status poll can consume `getStatus`; do not enable webhooks or offer terms for this slug.
