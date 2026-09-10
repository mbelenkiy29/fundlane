# MIC-150 report — Review email and secure selection

Status: DONE (webhook/preview mail; MIC-121 sender UI out of scope)

## Tests

`tests/underwriting-review.test.ts` — 6/6 passed.

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/underwriting-review.test.ts
```

Covered: recipients from configured membership roles plus CC; `funder_analysis_review` template and 5-minute HMAC link; expired/tampered/foreign-workspace tokens cannot submit; confirm revalidates completeness ready and score freshness; approval binds to that snapshot only; retries keep approval identity; DQ and empty selection 422; HTTP `deals:read`/`deals:write`/`intake:write` 403 and cross-workspace 404.

TDD: test file failed first with missing module, then implementation was added until green.

## Files changed

- `src/lib/mca/underwriting/review-mail.ts`
- `src/app/api/mca/underwriting/review/route.ts`
- `src/app/api/mca/underwriting/review/settings/route.ts`
- `src/app/api/mca/underwriting/review/[token]/route.ts`
- `src/app/api/mca/underwriting/review/deal/[dealId]/route.ts`
- `src/app/(dashboard)/review/[token]/page.tsx`
- `src/components/mca/underwriting/review-panel.tsx`
- `src/lib/mca/email.ts` (template union only: `funder_analysis_review`)
- `tests/underwriting-review.test.ts`
- `docs/milestone-03/MIC-150-acceptance.md`
- `docs/milestone-03/MIC-150-report.md`

Did not edit `analysis.ts`, `analysis-repository.ts`, `scoring.ts`, `deals-workspace.tsx`, or sender-connection UI.

## Exports

- `sendAnalysisReview` / `getDealReview` / `getReviewByToken` / `confirmAnalysisReview`
- `getReviewSettings` / `updateReviewSettings`
- `ReviewPanel({ dealId?, token? })`

## Remaining gates

MIC-121 production sender connections. Local Done is allowed with webhook/preview email and expired-token denial.

## Concerns

- `ReviewPanel` is exported for the conductor to mount on the deal Underwriting tab; this ticket did not edit `deals-workspace.tsx`.
- Approval updates `mca_analysis_runs.state` for the bound run/snapshot only via SQL in `review-mail.ts` so later reruns stay isolated.
