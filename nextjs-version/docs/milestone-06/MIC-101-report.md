# MIC-101 report — Team performance, distributions and company profit

Implemented the admin/super_admin team profit report on unique funnel totals from MIC-104, collected/expected ledger revenue, paid distributions, manager grouping, and reversal evidence.

## Files

- `src/lib/mca/reports/team-profit.ts`
- `src/app/api/mca/reports/team-profit/route.ts`
- `src/components/mca/reports/team-profit.tsx`
- `tests/milestone06-team-profit.test.ts`
- `docs/milestone-06/MIC-101-report.md`
- `docs/milestone-06/MIC-101-acceptance.md`

## Behavior

- Admin-only. Same session gate as the rep funnel (`admin` / `super_admin` + `features.reports`).
- Company deal counts come from `getRepFunnelReport(...).totals` and `SHARED_REP_ATTRIBUTION`. They are unique deals, never `sum(reps)`.
- User rows keep full originator/closer credit. Manager rows union the team's deals and payments once.
- Gross contribution = collected commission and fees − paid distributions. Lead-batch purchase costs are other operating costs and are not subtracted.
- Collected / expected recognition is a toggle; both amounts are on the payload.
- Voided payments, reversed funding events, and accounting adjustments appear as traceable evidence (record id, date, amount, correlation id). Voiding a collected fee drops company collected revenue and gross contribution.
- Missing `viewPaymentTable` returns `200` with Restricted money fields, not `$0`. Unique deal counts remain.

## Checks

```text
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-team-profit.test.ts
```

## Gates

none

## Handoff

Mount `TeamProfit` from `src/components/mca/reports/team-profit.tsx` on `/reports` at `#mca-reports-team-profit`. GET `/api/mca/reports/team-profit`.
