# MIC-122 brief — AI approval, decline, stipulation extraction

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-122
**Depends on:** MIC-149

## Exclusive files

- `src/lib/mca/submissions/extract-outcomes.ts`
- `src/app/api/mca/submissions/extract/**`
- `tests/submissions-extract.test.ts`
- `docs/milestone-04/MIC-122-report.md`
- `docs/milestone-04/MIC-122-acceptance.md`

Follow statement extraction (`src/lib/mca/underwriting/statement-extraction.ts`) for schema-constrained OpenAI usage. Fixture path when no API key: `provider_unavailable` vs injected fixture classifier.

## Rules

- Classify: approval, decline, pending/request-info, unrelated.
- Capture amount, rate, term, frequency, commission, fees, offer link, stips with source evidence.
- Approval **without** financial terms does not fabricate amounts (`terms_unknown = 1`).
- Pending request creates deduplicated tasks (store on reply row / deal note) retaining original message evidence.
- Email content is data, not instructions (prompt injection resistant system prompt).
- Manual correction + rerun preview + model/version tracking on the reply row.

## Tests

Approval without terms → no invented amount. Pending request deduped. Unrelated stays unmatched. Fixture classifier, no live network in tests.
