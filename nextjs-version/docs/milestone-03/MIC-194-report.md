# MIC-194 report — AI scan funder criteria

Status: DONE

## Tests

`tests/funders-scan.test.ts` — 7/7 passed.

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/funders-scan.test.ts
```

Covered: ambiguous FICO range flagged and unspecified; sentinel NSF not stored; contacts preserved; min FICO 650 not broadened to 600; accept/reject/rollback history; retry identity; clean PDF/PNG/JPEG only; yearly 120000 → monthly 10000; industry alias; HTTP permissions and 404 isolation; missing provider 503.

TDD: test file failed first with `MODULE_NOT_FOUND`, then implementation was added until green.

## Files changed

- `src/lib/mca/funders/criteria-scan.ts`
- `src/lib/mca/funders/scan-repository.ts`
- `src/app/api/mca/funders/scan/route.ts`
- `src/app/api/mca/funders/scan/[id]/route.ts`
- `src/app/api/mca/funders/scan/[id]/accept/route.ts`
- `src/app/api/mca/funders/scan/[id]/reject/route.ts`
- `src/app/api/mca/funders/scan/[id]/rollback/route.ts`
- `src/components/mca/funders/criteria-scan-panel.tsx`
- `tests/funders-scan.test.ts`
- `docs/milestone-03/MIC-194-acceptance.md`
- `docs/milestone-03/MIC-194-report.md`

Did not edit `documents/service.ts`, `documents/extraction.ts`, `directory.ts`, `criteria.ts`, `deals-workspace.tsx`, or `package.json`.

## Exports for later tickets

- `scanFunderCriteria(actor, { funderId, documentId })`
- `uploadAndScanFunderCriteria(actor, { funderId, dealId, idempotencyKey, filename, mimeType, bytes })`
- `listCriteriaScans` / `getCriteriaScan` / `listCriteriaScanDocuments`
- `acceptCriteriaScan` / `rejectCriteriaScan` / `rollbackCriteriaScan`
- `setCriteriaScanProviderForTests`
- `CriteriaScanPanel({ funderId })`

## Concerns

- Live OpenAI path is implemented (`store: false`, strict JSON Schema) but not exercised against a real model. Fixture success is not production integration readiness.
- `CriteriaScanPanel` is exported for the conductor to mount on funder detail; this ticket did not edit `/funders` or `deals-workspace.tsx`.
- Scan rows are created on first use (`CREATE TABLE IF NOT EXISTS mca_funder_criteria_scans`). A Drizzle migration for that table is a conductor follow-up.
