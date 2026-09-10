# MIC-179 report — AI bank-statement underwriting

**Status:** DONE locally with fixtures. Live OpenAI statement analysis is an external credential gate.

## Test summary

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/underwriting-statements.test.ts
```

9/9 passed.

| Test | Result |
| --- | --- |
| Duplicate statements same period/account do not double-count deposits | pass |
| Uncertain extraction stays unknown in the aggregate and is never presented as zero | pass |
| Savings classified unsupported and excluded from revenue | pass |
| Unique checking accounts in the same period are summed before the monthly average | pass |
| Cross-workspace analysis is a 404 | pass |
| Analyze is idempotent on unchanged documents | pass |
| Pending and quarantined statements are not analyzed | pass |
| Missing live credentials fail closed as `provider_unavailable` | pass |
| `deals:read` lists, `deals:write` analyzes, `intake:write` is 403 | pass |

Typecheck: `pnpm exec tsc --noEmit` passed after implementation.

TDD: `tests/underwriting-statements.test.ts` was written and run first (MODULE_NOT_FOUND), then implementation was added until green.

## Files

Created/modified (exclusive map only):

- `src/lib/mca/underwriting/statements.ts`
- `src/lib/mca/underwriting/statement-repository.ts`
- `src/lib/mca/underwriting/statement-extraction.ts`
- `src/app/api/mca/underwriting/statements/route.ts`
- `src/app/api/mca/underwriting/statements/[dealId]/route.ts`
- `src/app/api/mca/underwriting/statements/[dealId]/analyze/route.ts`
- `src/components/mca/underwriting/statement-panel.tsx`
- `tests/underwriting-statements.test.ts`
- `docs/milestone-03/MIC-179-acceptance.md`
- `docs/milestone-03/MIC-179-report.md`

Did not edit `documents/service.ts`, `documents/extraction.ts`, `funders/**`, `deals-workspace.tsx`, or `package.json`. Analysis is invoked only via `analyzeDealStatements` from the analyze route and statement panel.

## Behavior shipped

- Clean `statement` documents only. Pending/quarantined/other categories are skipped; content is read through `getDocumentContent`.
- Checking-only aggregates. Non-checking extracted kinds are stored as `unsupported` and excluded.
- Duplicates (same deal + period + account suffix, or same period with overlapping known deposits when suffix is absent) set `duplicateOfId` and are excluded from aggregates.
- Unknown metrics persist as `{ value: null, unknown: true }`. Aggregates that depend on an unknown unique checking month are unknown, never 0.
- `monthlyRevenue` / ADB: average of unique checking months, with same-period accounts summed first. NSF and negative days: sums. Documented in `MIC-179-acceptance.md`.
- Existing-position candidates are `proposed`, de-duplicated by label, and not treated as confirmed facts.
- Unchanged clean-document set: same month ids, same `extractionVersion`, same aggregate `version`; provider is not recalled.
- Successful analyze sets `stale: false` and increments `version` only when the document set changed.
- Permissions: `deals:read` GET, `deals:write` POST analyze, `intake:write` 403. Cross-workspace 404 `deal_not_found`.
- Missing provider credentials: 503 `provider_unavailable`.
- UI: months + aggregates + positions, Unknown not 0, unsupported/duplicate flags, rerun, loading/empty/error.

## Concerns

- Live `OPENAI_API_KEY` / `MCA_DOCUMENT_AI_MODEL` path is implemented (`store: false`, strict JSON Schema) but not exercised against a real model. Fixture success is not production integration readiness.
- `StatementPanel` is exported for the conductor to mount on the deal Underwriting tab; this ticket did not edit `deals-workspace.tsx`.
- `mca_statement_months` includes `corrected*` columns and `original_extraction` so MIC-172 can append without rewriting originals. Position confirm/dismiss is out of scope.
- HTTP coverage is in-process against route handlers (same pattern as documents-core actor tests), not a running Next server.
