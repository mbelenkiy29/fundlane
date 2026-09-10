# MIC-170 report — Eligibility rules

Status: DONE

## Tests

`tests/funders-criteria.test.ts` — 8/8 passed.

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/funders-criteria.test.ts
```

Covered: `convertRevenueThreshold` yearly 120000 → monthly 10000; same field+unit min>max → 422 `criteria_conflict`; yearly vs monthly revenue conflict after conversion; `unspecified:true` stores SQL NULL; 14-field publish + version bump; industry alias normalize/isolation; HTTP permissions and cross-workspace 404.

TDD: test file failed first with `MODULE_NOT_FOUND`, then implementation was added until green.

## Files changed

- `src/lib/mca/funders/criteria.ts`
- `src/lib/mca/funders/criteria-repository.ts`
- `src/app/api/mca/funders/criteria/[funderId]/route.ts`
- `src/app/api/mca/funders/criteria/aliases/route.ts`
- `src/app/api/mca/funders/criteria/aliases/[id]/route.ts`
- `src/components/mca/funders/criteria-panel.tsx`
- `tests/funders-criteria.test.ts`
- `docs/milestone-03/MIC-170-acceptance.md`
- `docs/milestone-03/MIC-170-report.md`

Did not edit `directory.ts`, `directory-repository.ts`, `deals-workspace.tsx`, `package.json`, or `underwriting/**`.

## Exports for later tickets

- `convertRevenueThreshold({ value, from, to })`
- `listFunderCriteria(actor, funderId)` / `publishFunderCriteria(actor, funderId, rules)`
- `listIndustryAliases` / `getIndustryAlias` / `upsertIndustryAlias` / `deleteIndustryAlias` / `resolveIndustry`
- `CRITERIA_FIELDS`
- `CriteriaPanel({ funderId })`

## Concerns

- `criteriaVersion` is incremented with a direct `UPDATE mca_funders` because `updateFunder` only bumps `profileVersion` and this ticket cannot edit directory modules.
- `CriteriaPanel` is exported for the conductor to mount on funder detail; this ticket did not edit `/funders` or `deals-workspace.tsx`.
