# MIC-170 brief — Eligibility rules

Ticket: https://linear.app/michael-belenkiy/issue/MIC-170/funder-eligibility-rules-and-industry-normalization

Exclusive files:
- `src/lib/mca/funders/criteria.ts`
- `src/lib/mca/funders/criteria-repository.ts`
- `src/app/api/mca/funders/criteria/**`
- `src/components/mca/funders/criteria-panel.tsx`
- `tests/funders-criteria.test.ts`
- `docs/milestone-03/MIC-170-acceptance.md`
- `docs/milestone-03/MIC-170-report.md`

Import `listFunders`/`getFunder` from `funders/directory.ts`. Do not edit directory.ts except if a type-only re-export is required (prefer not).

Must: yearly min 120000 converts to monthly 10000 via explicit helper `convertRevenueThreshold`. Conflicting min/max on same field+unit → 422 `criteria_conflict`. `unspecified: true` stores null value, never sentinel. Version criteriaVersion on funder via calling `updateFunder` or your own version column on rules table.

No git. No subagents. TDD. Report short contract.
