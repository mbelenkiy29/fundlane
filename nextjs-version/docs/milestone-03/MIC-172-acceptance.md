# MIC-172 acceptance — Manual underwriting corrections

Executed locally against fixture storage and MIC-179 statement analysis. No live model calls.

## Correction rule

- Original extraction JSON on `mca_statement_months.original_extraction` is immutable.
- A metric edit stores `corrected=1`, reason, actor, and timestamp, then recomputes the MIC-179 aggregate (unique checking months; same-period accounts summed then averaged).
- `UnderwritingAggregate.stale` is set `true` after a correction. Snapshot tables with a `stale` column are marked if they exist.
- Analyze persists cannot overwrite a reviewed month unless `replaceReviewed: true` (corrections analyze route). MIC-179 `analyzeDealStatements` does not pass that flag.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| One monthly revenue change | Aggregate recalculated, `stale: true`, original deposits unchanged | `tests/underwriting-corrections.test.ts` |
| Concurrent/subsequent analyze | Reviewed deposits kept unless `replaceReviewed: true` | same |
| Position confirm | Status retained across analyze, aggregate stale | same |
| Cross-workspace | 404 `deal_not_found` | same |
| Validation | Empty reason / NaN metric → 422 `validation_failed` | same |
| Scopes | `deals:read` GET, `deals:write` POST, `intake:write` 403 | same |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/underwriting-corrections.test.ts
```

## Permissions

- GET corrections: `deals:read`
- POST month/position correction: `deals:write`
- POST analyze (`replaceReviewed`): `deals:write`
- `intake:write` → 403

## UI

`CorrectionPanel` covers loading, empty, validation, success, and failure. Source vs manual badges. Analyze warns and requires an explicit replace-reviewed check.
