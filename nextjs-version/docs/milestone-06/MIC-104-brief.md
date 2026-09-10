# MIC-104 brief — Rep performance funnel and funding report

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-104
**UUID:** `5453bba0-4969-4795-b635-40c2bb2bfe47`
**Depends on:** MIC-93, MIC-112, MIC-94 (done)

## Exclusive files

- `src/lib/mca/reports/rep-funnel.ts`
- `src/app/api/mca/reports/rep-funnel/**`
- `src/components/mca/reports/rep-funnel.tsx`
- `tests/milestone06-rep-funnel.test.ts`
- `docs/milestone-06/MIC-104-report.md`
- `docs/milestone-06/MIC-104-acceptance.md`

Do not edit `reports/page.tsx` (conductor mounts). Admin/super_admin + `features.reports` only. No git. No subagents. Do not mark Linear Done.

## Frozen behavior

- Filters: rep + date range with explicit `basis: "event" | "cohort"` from `reports/contracts.ts`.
- Unique-deal counts: a deal submitted to five funders is one submitted deal.
- Show created, submitted, approved, funded counts/amounts, conversions, attributed distributions.
- Drilldown totals must equal the report total for the same filters.
- Missing payment permission is a restricted state, not $0.
- Shared-rep attribution must be defined in the acceptance doc and applied consistently.

## Acceptance

- Five-funder deal counts as one submitted deal.
- Total reconciles to drilldown.
- Synthetic scenario, UI states, API permissions, no secrets in logs.
