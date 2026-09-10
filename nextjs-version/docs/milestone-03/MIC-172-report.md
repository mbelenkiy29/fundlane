# MIC-172 report — Manual underwriting corrections

**Status:** DONE locally. Live OpenAI re-extraction is the same external credential gate as MIC-179.

## Test summary

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/underwriting-corrections.test.ts
```

5/5 passed. MIC-179 `tests/underwriting-statements.test.ts` 9/9 still passed. `pnpm exec tsc --noEmit` passed.

TDD: tests were written first (`MODULE_NOT_FOUND`), then implementation.

| Test | Result |
| --- | --- |
| Changing one monthly revenue recalculates aggregate and sets stale | pass |
| Analyze cannot silently overwrite a reviewed correction unless replaceReviewed | pass |
| Position confirm retained and marks stale | pass |
| Validation and cross-workspace 404 | pass |
| deals:read lists, deals:write corrects, intake:write 403 | pass |

## Files

- `src/lib/mca/underwriting/corrections.ts`
- `src/lib/mca/underwriting/statement-repository.ts` (correction helpers + preserve-reviewed persist)
- `src/app/api/mca/underwriting/corrections/**`
- `src/components/mca/underwriting/correction-panel.tsx`
- `tests/underwriting-corrections.test.ts`
- `docs/milestone-03/MIC-172-acceptance.md`
- `docs/milestone-03/MIC-172-report.md`

Did not edit `statements.ts`, scoring, funders, or `deals-workspace.tsx`.

## Behavior

- `correctStatementMonth` / `correctExistingPosition` keep original extraction, store actor/time/reason, recompute aggregate, `stale: true`.
- `analyzeDealStatementsForCorrections({ replaceReviewed })` is the explicit replace path. Default analyze preserves reviewed metrics.
- UI: original vs current, Manual/Extraction badges, stale, replace-reviewed checkbox.

## Concerns

- `CorrectionPanel` is exported for the conductor to mount on the deal Underwriting tab.
- Analysis snapshot stale updates run only if a later ticket creates a snapshot table with a `stale` column.
