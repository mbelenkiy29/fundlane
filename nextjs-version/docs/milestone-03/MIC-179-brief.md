# MIC-179 brief — AI bank-statement underwriting

Ticket: https://linear.app/michael-belenkiy/issue/MIC-179/ai-bank-statement-underwriting-and-existing-positions

You implement **only** this ticket. Do not spawn subagents. There is **no git repository** — do not run git commit.

## Exclusive files

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

Import only (do not edit): `underwriting/contracts.ts`, `documents/service.ts` (`listDocuments`, `getDocumentContent`), `documents/contracts.ts`, `deals/service.ts` (`getDeal` / `getDealForDocument` / `createDeal` in tests), `db.ts`, `auth.ts`, `errors.ts`, `http.ts`.

Do not edit `documents/service.ts`, `documents/extraction.ts`, `funders/**`, `deals-workspace.tsx`, `package.json`.

## Frozen types

`StatementMonthRecord`, `ExistingPositionCandidate`, `UnderwritingAggregate`, `MetricEvidence`, `STATEMENT_ACCOUNT_KINDS` from `src/lib/mca/underwriting/contracts.ts`.

Rulings:

- Unknown is not zero. Corrupt/uncertain scans: `unknown: true`, `value: null`. Never present 0 as a fact.
- Checking-account statements only. Savings/credit-card/loan (or extracted kind not checking) → `accountKind: "unsupported"` and excluded from aggregates.
- Duplicate statements (same deal, period, accountSuffix, overlapping deposits) set `duplicateOfId` and do not double-count deposits in aggregates.
- Do not hook inside `documents/service.ts`. Expose `analyzeDealStatements(actor, dealId)` and call it from the analyze route and statement panel.

## Required exports

- `analyzeDealStatements(actor, dealId): Promise<{ months: StatementMonthRecord[]; positions: ExistingPositionCandidate[]; aggregate: UnderwritingAggregate }>`
- `listStatementMonths(actor, dealId)`
- `getUnderwritingAggregate(actor, dealId)`
- `setStatementExtractionProviderForTests(provider?)` for a fixture that returns metrics + accountKind + period + positions.

Provider interface lives in `statement-extraction.ts`. Fixture in tests. Missing live credentials → `AppError(503, "provider_unavailable", ...)`.

Use only **clean** statement-category documents. Quarantined/pending must not be analyzed.

Aggregates: sum unique (non-duplicate, checking) monthly deposits as `monthlyRevenue` (or average of months — pick **average of unique checking months' deposits** and document it in the acceptance file). ADB = average of unique months' ADB. NSF/negative days = sums. `stale: false` after a successful analyze. `version` increments per successful analyze.

Permissions: deal visibility (`deals:read` list, `deals:write` analyze). `intake:write` 403.

UI `StatementPanel({ dealId })`: tables for months and aggregates, unknown shown as "Unknown" not 0, unsupported flagged, rerun button, loading/empty/error.

## Tests (TDD)

Temp SQLite + in-memory document storage like `tests/documents-core.test.ts`. Store two clean statement PDFs via `storeDocument` with scanner fixture clean.

Must include:

- Two statements same period/account: second is duplicate; aggregate deposits not doubled.
- Uncertain extraction: `unknown: true`, aggregate metric unknown, not 0.
- Savings classified unsupported, excluded from revenue.
- Cross-workspace 404.
- Analyze is idempotent on unchanged documents (same extractionVersion / same month ids on retry).

```
cd nextjs-version
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/underwriting-statements.test.ts
```

## Report

`docs/milestone-03/MIC-179-report.md` then short status contract.
