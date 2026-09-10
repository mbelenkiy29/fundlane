# MIC-163 report — Explainable scoring

Status: DONE

## Tests

`tests/underwriting-scoring.test.ts` — 6/6 passed.

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/underwriting-scoring.test.ts
```

Covered: hard DQ before score (state fail → grade DQ, score 0, not auto-selectable); same inputs + `policyVersion` 1 → identical scores and retry snapshot identity; synthetic A-grade 90 fit vs FICO/revenue DQ; missing FICO is `unknown` never a fake pass, unspecified FICO skipped; criteria version and underwriting `computedAt` change mark stale then reanalyze; HTTP `deals:read`/`deals:write`/`intake:write` 403 and cross-workspace 404.

TDD: test file failed first with missing module, then implementation was added until green.

## Files changed

- `src/lib/mca/underwriting/policy.ts`
- `src/lib/mca/underwriting/scoring.ts`
- `src/lib/mca/underwriting/snapshot-repository.ts`
- `src/app/api/mca/underwriting/scores/[dealId]/route.ts`
- `src/components/mca/underwriting/score-panel.tsx`
- `tests/underwriting-scoring.test.ts`
- `docs/milestone-03/MIC-163-acceptance.md`
- `docs/milestone-03/MIC-163-report.md`

Did not edit `directory.ts`, `criteria.ts`, `statements.ts`, `deals/service.ts`, `deals-workspace.tsx`, sending, or email.

## Exports for later tickets

- `scoreDeal(actor, dealId)` / `getDealScores(actor, dealId)`
- `evaluateFunderScore` / `rankScores` / `autoSelectableFunderIds`
- `POLICY_VERSION` / `SCORE_FIT_DISCLAIMER`
- `ScorePanel({ dealId })`

DQ funders have `eligible: false` and grade `DQ`. `autoSelectableFunderIds` omits them (MIC-148).

## Concerns

- `ScorePanel` is exported for the conductor to mount on the deal Underwriting tab; this ticket did not edit `deals-workspace.tsx`.
- Wave 2 directory/criteria/statement modules still call synchronous SQLite `exec`. Scoring awaits their public APIs and falls back to SQL reads so it can run on the current async Postgres `db.ts`.
- Tests load `DATABASE_URL` from `.neon/migration-connections.json` `verification` when unset, create isolated workspace rows, and delete them after.
