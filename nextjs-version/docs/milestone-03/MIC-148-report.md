# MIC-148 report — Analysis modes

Status: DONE (automatic_send fail-closed)

## Tests

`tests/underwriting-analysis.test.ts` — 6/6 passed.

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/underwriting-analysis.test.ts
```

Covered: default `review_first`; `analyze_only` never queues or selects; review-first selects top-N and blocks DQ; `email_only` does not pre-select; automatic send requires admin enablement, snapshots settings, calls `queueSubmissions`, state `submission_unavailable`; run override leaves defaults; retry keeps run identity and does not duplicate sends; no-qualified-funder is first-class; readiness trigger fires once per completeness version; HTTP `deals:read`/`deals:write`/`intake:write` 403 and cross-workspace 404.

TDD: test file failed first with missing module, then implementation was added until green.

## Files changed

- `src/lib/mca/underwriting/analysis.ts`
- `src/lib/mca/underwriting/analysis-repository.ts`
- `src/app/api/mca/underwriting/analysis/route.ts`
- `src/app/api/mca/underwriting/analysis/[dealId]/route.ts`
- `src/components/mca/underwriting/analysis-panel.tsx`
- `tests/underwriting-analysis.test.ts`
- `docs/milestone-03/MIC-148-acceptance.md`
- `docs/milestone-03/MIC-148-report.md`

Did not edit `scoring.ts`, `completeness.ts`, `submission-port.ts`, `deals-workspace.tsx`, or sending.

## Exports for later tickets

- `runAnalysis(actor, dealId, override?)` / `runAnalysisIfReady(actor, dealId)` / `getDealAnalysis(actor, dealId)`
- `getAnalysisSettings` / `updateAnalysisSettings`
- `AnalysisPanel({ dealId })`

`queueSubmissions` is imported from `underwriting/submission-port.ts` and always returns `submission_unavailable`. No submission rows are created.

## Remaining gates

MIC-166 live send. Local Done is allowed with automatic send fail-closed.

## Concerns

- `AnalysisPanel` is exported for the conductor to mount on the deal Underwriting tab; this ticket did not edit `deals-workspace.tsx`.
- Review email / signed token is MIC-150.
