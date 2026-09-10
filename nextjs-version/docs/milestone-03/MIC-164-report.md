# MIC-164 report

## Status

Complete. Document completeness checks persist versioned results and a single readiness event per findings change. Missing months use `missing_statement_YYYY-MM` and force `ready: false`. Unchanged reruns keep the same version and do not emit another event. Readiness ignores deal `draftState`.

## Test summary

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/underwriting-completeness.test.ts
```

Result: **8 passed, 0 failed**.

- Application plus 2 of 3 months → not ready, named `missing_statement_YYYY-MM` for the gap
- Unchanged rerun keeps version and a single readiness event
- Quarantined statement → `unreadable_document`, `ready: false`
- Partial draft with required docs → `ready: true`
- Cross-workspace actor → 404 `deal_not_found`
- Unknown filename period / display-original mismatch; MIC-179 checking months preferred
- Settings admin-only; `intake:write` 403; GET empty then POST rerun persists `missing_application`

## Files

- `src/lib/mca/underwriting/completeness.ts`
- `src/lib/mca/underwriting/completeness-repository.ts`
- `src/app/api/mca/underwriting/completeness/route.ts`
- `src/app/api/mca/underwriting/completeness/[dealId]/route.ts`
- `src/components/mca/underwriting/completeness-panel.tsx`
- `tests/underwriting-completeness.test.ts`
- `docs/milestone-03/MIC-164-acceptance.md`
- `docs/milestone-03/MIC-164-report.md`

## Concerns

- MIC-179 `mca_statement_months` is detected at runtime (`sqlite_master` + try/catch). Expected columns: `deal_id`, `document_id`, `account_kind`, `period`. If MIC-179 ships different names, the query fails closed and filename fallback still applies.
- CompletenessPanel is not mounted on the deal workspace (conductor / Wave 1 shared mount).
- Settings writes are service-admin-role plus HTTP session (`requireMembershipAccess`). API keys cannot change N.
- Lookback uses UTC, not workspace timezone, per the brief.

## Report path

`docs/milestone-03/MIC-164-report.md`
