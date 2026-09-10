# MIC-179 acceptance — AI bank-statement underwriting

Executed locally against fixture storage, a clean/infected scanner double, and a deterministic statement-extraction provider. Live OpenAI statement analysis remains an external credential gate.

## Aggregation rule

`monthlyRevenue` is the **average of unique checking months' deposits**.

- A unique checking month is a stored `StatementMonthRecord` whose `accountKind` is `checking` and that is not a duplicate (`duplicateOfId` unset).
- Deposits from multiple unique checking accounts in the **same period** are **summed first**, then those period totals are averaged. This is total operating deposits per calendar month, not an average of accounts.
- Duplicate statements (same deal, period, and account suffix; or same period with overlapping known deposits when the suffix is absent) set `duplicateOfId` and are excluded from every aggregate.
- Savings, credit-card, loan, and any other non-checking extraction are stored as `accountKind: "unsupported"` and excluded.
- `averageDailyBalance` uses the same unique-checking, per-period-sum-then-average rule.
- `nsfCount` and `negativeDays` are **sums** across unique checking statements.
- If any contributing unique checking metric is unknown (`unknown: true` or `value: null`), the aggregate metric is unknown with `value: null`. Unknown is never replaced with 0.

`stale` is `false` after a successful analyze. `version` increments only when the clean statement document set changes.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Duplicate same period/account | Deposits not doubled | `tests/underwriting-statements.test.ts` |
| Uncertain extraction | Aggregate `unknown: true`, value `null`, not 0 | same |
| Savings unsupported | Excluded from revenue | same |
| Multi-account month | Period totals summed, then averaged | same |
| Cross-workspace | 404 `deal_not_found` | same |
| Idempotent rerun | Same month ids, extractionVersion, aggregate version; provider not recalled | same |
| Pending/quarantined skipped | Only clean statement-category documents analyzed | same |
| Missing credentials | 503 `provider_unavailable` | same |
| Scopes | `deals:read` list, `deals:write` analyze, `intake:write` 403 | same |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/underwriting-statements.test.ts
```

## Behavior

- `analyzeDealStatements(actor, dealId)` is the only analysis entry. The analyze route and `StatementPanel` call it. `documents/service.ts` is not hooked.
- Analysis reads clean statement documents through `listDocuments` / `getDocumentContent` (scanner remains in force).
- Provider fixture is injected with `setStatementExtractionProviderForTests`. Live path reuses `MCA_DOCUMENT_AI_PROVIDER=openai`, `OPENAI_API_KEY`, and `MCA_DOCUMENT_AI_MODEL` with `store: false` and strict JSON Schema. Missing credentials fail closed.
- Existing-position rows are candidates (`proposed`) for review, de-duplicated by label, and not treated as confirmed debts.
- UI shows Unknown (never 0) for unknown metrics, flags unsupported and duplicate months, and supports loading, empty, error, success, and rerun.

## External gate

Live model verification is pending real `OPENAI_API_KEY` / `MCA_DOCUMENT_AI_MODEL` credentials. Fixture success is not production integration readiness.
