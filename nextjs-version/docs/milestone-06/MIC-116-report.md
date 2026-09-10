# MIC-116 report — Lead source and batch conversion, CAC and ROI analytics

Implemented admin/super_admin lead-source CAC and ROI against latest `mca_deal_acquisition_events`, current `lead_batches.cost_cents`, unique-deal submitted/approved/funded stages, and non-void `mca_accounting_payments` commission rows.

## Files

- `src/lib/mca/reports/lead-roi.ts`
- `src/app/api/mca/reports/lead-roi/route.ts`
- `src/components/mca/reports/lead-roi.tsx`
- `tests/milestone06-lead-roi.test.ts`
- `docs/milestone-06/MIC-116-report.md`
- `docs/milestone-06/MIC-116-acceptance.md`

## Behavior

- Cohort counts: unique acquired deals through submitted, approved, and funded, plus collected commission by source/batch.
- Cost per funded merchant and cost per funded deal are separate. Zero denominators are `N/A`. Missing cost is not `$0`.
- Collected ROI = (attributed collected commission − purchase cost) / purchase cost. Expected-value and including-follow-on variants are labeled separately.
- Zero-cost batches (`cost_cents = 0`) have undefined ROI, not infinity.
- Renewals (`mca_renewal_actions.renewed_deal_id`) and extra committed fundings on the same deal do not increment acquisition or funded-deal counts.
- Filters: source, batch, inclusive `from`/`to`, required `basis: event | cohort`. Drilldown reconciles to totals. Missing-cost warnings are returned on the payload.
- Missing `viewPaymentTable` is a restricted `200` (commission/ROI omitted), not `$0`.

## Checks

```text
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-lead-roi.test.ts
```

Pass (10 tests).

## Gates

none

## Handoff

Mount `LeadRoi` from `src/components/mca/reports/lead-roi.tsx` on `/reports` at `#mca-reports-lead-roi`. GET `/api/mca/reports/lead-roi`.
