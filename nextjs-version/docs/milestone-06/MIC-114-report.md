# MIC-114 report — Funder analytics and commission performance

Implemented admin/super_admin funder analytics against submission jobs, `deal_submissions`, `mca_offers` / revisions, committed `mca_funding_events`, and the `mca_accounting_payments` ledger.

## Files

- `src/lib/mca/reports/funder-analytics.ts`
- `src/app/api/mca/reports/funders/route.ts`
- `src/app/api/mca/reports/funders/[funderId]/route.ts`
- `src/components/mca/reports/funder-analytics.tsx`
- `tests/milestone06-funder-analytics.test.ts`
- `docs/milestone-06/MIC-114-report.md`
- `docs/milestone-06/MIC-114-acceptance.md`

## Behavior

- Grouped by funder: submission count, unique merchant (`deal_id`) count, approvals, committed fundings, collected commissions.
- Lifetime (omit `from`/`to`) and date-filtered views. `basis` is required: `event` (each metric’s own timestamp) or `cohort` (deal created in range). Inclusive `YYYY-MM-DD` in the workspace timezone.
- Approval identity is one per submission/offer. Three revisions on one Harbor offer still count as **one** approval.
- Earned commission totals are non-void ledger `received_amount_cents` for `type=commission`. Fees stay in payment drilldown. Void rows are omitted.
- Drilldown lists submission / approval / advance / payment sources and keeps API vs email channels distinct.
- Incomplete periods are labeled. Missing offer terms are unknown, not `$0`. Zero denominators are `N/A`.
- Missing `viewPaymentTable` returns `200` with `paymentsVisible: false` and Restricted commissions, not `$0`.

## Checks

```text
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-funder-analytics.test.ts
```

Pass (9 tests).

## Gates

none

## Handoff

Mount `FunderAnalytics` from `src/components/mca/reports/funder-analytics.tsx` on `/reports` at `#mca-reports-funders`. GET `/api/mca/reports/funders` and GET `/api/mca/reports/funders/[funderId]`.
