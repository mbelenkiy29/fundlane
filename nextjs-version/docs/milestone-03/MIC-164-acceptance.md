# MIC-164 acceptance — Document completeness

## Rules

- Required documents: one **clean** `application` or `api_application`, plus **N** recent **checking** statement months.
- Workspace default **N = 3**, stored in `mca_completeness_settings`. Admins (`admin` / `super_admin`) write N (1–24).
- Lookback is **inclusive of the current UTC month** and the previous N−1 calendar months. On 2026-09-08 with N=3 the required periods are `2026-07`, `2026-08`, `2026-09`.
- Readiness is **independent of deal `draftState` and application field completeness**. A partial deal with the required documents is `ready: true`.

## Findings

| Code | When |
| --- | --- |
| `missing_application` | No clean application / api_application |
| `missing_statement_YYYY-MM` | Required lookback month has no clean checking statement |
| `unreadable_document` | Statement or application is `quarantined` or `scan_failed` |
| `unknown_statement_period` | Clean statement has no parseable `YYYY-MM` in display/original filename (and no MIC-179 month) |
| `period_mismatch` | Display vs original filename periods disagree, or filename period disagrees with `mca_statement_months` |

A missing month always sets `ready: false` with code exactly `missing_statement_YYYY-MM`.

## Statement month source

1. If `mca_statement_months` exists (MIC-179), prefer **checking** rows for that document.
2. Otherwise parse `displayFilename` / `originalFilename` for `YYYY-MM`.
3. Table detection uses `sqlite_master` and a try/catch query so this ticket **compiles and runs without MIC-179**.

## Persistence

- Each check stores `version` and `ruleSnapshot` JSON on `mca_completeness_results`.
- Findings fingerprint (code + documentId + period) compared to the latest row.
- Unchanged fingerprint → return the previous result (same version, same `checkedAt`) and **do not** insert `mca_readiness_events`.
- Changed findings → increment version and insert **one** readiness event.

## Permissions

- GET deal completeness: `deals:read`
- POST rerun: `deals:write`
- Settings write: interactive admin session
- `intake:write` → 403 `scope_required`

## UI

`CompletenessPanel({ dealId })` shows loading, empty (no check yet), error, ready / not ready, named missing months, and a rerun control.

## Tests

```
cd nextjs-version
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/underwriting-completeness.test.ts
```

Covered: missing month named request; unchanged rerun does not increment version or emit a second event; unreadable statement blocks ready; partial fields still ready; cross-workspace 404; filename unknown/mismatch; MIC-179 checking months preferred over savings filenames; intake:write 403.
