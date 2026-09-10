# MIC-104 report — Rep performance funnel and funding report

Implemented the admin/super_admin rep funnel against `deal_activity`, `deal_submissions`, `mca_offers` / revisions, committed `mca_funding_events`, and `mca_accounting_payments` / `mca_payment_distributions`.

## Files

- `src/lib/mca/reports/rep-funnel.ts`
- `src/app/api/mca/reports/rep-funnel/route.ts`
- `src/components/mca/reports/rep-funnel.tsx`
- `tests/milestone06-rep-funnel.test.ts`
- `docs/milestone-06/MIC-104-report.md`
- `docs/milestone-06/MIC-104-acceptance.md`

## Behavior

- Filters: rep, inclusive `from`/`to` (`YYYY-MM-DD`, workspace tz), required `basis: event | cohort`, optional funder/source/batch.
- Unique-deal counts: five funder submissions = one submitted deal.
- Shared-rep attribution: full credit per assigned originator/closer; `totals` are unique deals for MIC-101. Distributions follow recipient rows and sum to the unique total.
- Drilldown deal counts and known cents equal `totals` for the same filters (`drilldownReconciles`).
- Unknown offer terms and missing timestamps are not invented. Reversed funding is omitted. Zero denominators are `N/A`. Incomplete periods are labeled.
- Missing payment permission is a restricted state on the `200` payload, not `$0`.

## Checks

```text
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-rep-funnel.test.ts
```

Pass (11 tests).

## Gates

none

## Handoff

Mount `RepFunnel` from `src/components/mca/reports/rep-funnel.tsx` on `/reports` at `#mca-reports-rep-funnel`. GET `/api/mca/reports/rep-funnel`. MIC-101 must use `totals` (unique deals) and `SHARED_REP_ATTRIBUTION`, not `sum(reps)`.
