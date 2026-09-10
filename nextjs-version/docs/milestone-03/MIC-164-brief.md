# MIC-164 brief — Document completeness

Ticket: https://linear.app/michael-belenkiy/issue/MIC-164/ai-document-completeness-checks-and-missing-document-recovery

You implement **only** this ticket. Do not spawn subagents. There is **no git repository** — do not run git commit.

## Exclusive files

- `src/lib/mca/underwriting/completeness.ts`
- `src/lib/mca/underwriting/completeness-repository.ts`
- `src/app/api/mca/underwriting/completeness/route.ts`
- `src/app/api/mca/underwriting/completeness/[dealId]/route.ts`
- `src/components/mca/underwriting/completeness-panel.tsx`
- `tests/underwriting-completeness.test.ts`
- `docs/milestone-03/MIC-164-acceptance.md`
- `docs/milestone-03/MIC-164-report.md`

Import only: `underwriting/contracts.ts`, `documents/service.ts` (`listDocuments`, `getDocument`), `documents/contracts.ts`, `deals/service.ts`, `db.ts`, `auth.ts`, `errors.ts`, `http.ts`, `workspaces.ts` if you store workspace default month count in a small table you own.

Do not edit documents, funders, deals-workspace, package.json, statements.ts.

## Frozen types

`CompletenessResult`, `CompletenessFinding` from contracts.

## Required behavior

1. Workspace default: require an **application** (category `application` or `api_application`, processingState `clean`) and **N recent checking-statement months** (default N=3). Store N in `mca_completeness_settings` per workspace (admin write).
2. Findings:
   - `missing_application`
   - `missing_statement_YYYY-MM` for each missing month in the lookback window
   - `unreadable_document` for statement/application `quarantined` | `scan_failed`
   - `period_mismatch` when a statement filename/month cannot be parsed (if displayFilename looks like a period but disagrees) — keep this conservative; missing parse is `unknown_statement_period`, not ready.
3. Readiness is **independent** of deal `draftState` / application field completeness. A partial deal with required docs can be `ready: true`.
4. Persist result with `version` and `ruleSnapshot` JSON. `checkCompleteness(actor, dealId)` :
   - If findings fingerprint unchanged vs last row, return previous result (same version) — **do not** emit a new readiness event.
   - If findings changed, increment version and insert `mca_readiness_events` once.
5. Missing month → `ready: false` and finding code exactly `missing_statement_YYYY-MM`.
6. Lookback window: calendar months ending at current UTC month, count N. Example: N=3 on 2026-09-08 requires 2026-07, 2026-08, 2026-09 unless you document "complete prior months excluding current" — **use inclusive current month and the previous N-1**.
7. Statement month source until MIC-179 is merged: parse `displayFilename` / `originalFilename` for `YYYY-MM`. If MIC-179 tables exist (`mca_statement_months`), prefer those checking months — use try/catch or `sqlite_master` check so this ticket compiles **without** MIC-179. Filename fallback is required.

Permissions: `deals:read` to get, `deals:write` to rerun. Settings N: admin session. `intake:write` 403.

UI `CompletenessPanel({ dealId })`: ready/not ready, named missing months, rerun, loading/empty/error.

Exports:

- `checkCompleteness(actor, dealId): CompletenessResult`
- `getCompleteness(actor, dealId): CompletenessResult | null`
- `setRequiredStatementMonths(actor, n: number)` admin
- `listReadinessEvents(actor, dealId)`

## Tests (TDD)

- Deal with application but only 2 of 3 months → not ready, finding `missing_statement_YYYY-MM` for the gap.
- Unchanged rerun does not increment version / does not add a second readiness event.
- Unreadable statement blocks ready.
- Partial application fields still ready if docs satisfy rules.
- Cross-workspace 404.

```
cd nextjs-version
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/underwriting-completeness.test.ts
```

## Report

`docs/milestone-03/MIC-164-report.md` then short status contract.
