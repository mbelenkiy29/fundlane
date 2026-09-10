# MIC-163 acceptance — Explainable scoring

Executed September 8, 2026. Scope: hard disqualification before scoring, reproducible policy v1 grades, persisted snapshots, and fit-not-odds copy.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Scoring core + HTTP | 6/6 passed | `tests/underwriting-scoring.test.ts` |
| Hard DQ before score | Passed | State-blocked funder is grade `DQ`, score `0`, no soft reasons, `eligible: false` |
| Auto-select exclusion | Passed | `autoSelectableFunderIds` contains only eligible funders |
| Same inputs + policyVersion 1 | Passed | Retry returns the same snapshot id and identical scores |
| Synthetic fit scenario | Passed | Fit funder grade A / score 90; FICO min 700 and monthly min 25000 DQ |
| Missing input is unknown | Passed | Specified FICO min + missing FICO → `unknown`, never `pass`; unspecified FICO skipped |
| Criteria / underwriting change | Passed | Criteria version bump and aggregate `computedAt` change mark stale; reanalyze writes a new snapshot |
| Permissions / isolation | Passed | `deals:read` GET empty then `deals:write` POST; `intake:write` 403; foreign workspace 404 |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/underwriting-scoring.test.ts
```

## Behavior

- Hard DQ fields (policy v1): state, entity, industry, default flag, NSF max, negative-day max, position max, time-in-business, FICO, min revenue. Fail or unknown on a specified restriction disqualifies before any soft score.
- Soft score 0–100 from available monthly revenue fit, ADB, NSF, positions, requested amount vs max, FICO. Weights are named constants in `underwriting/policy.ts`. Missing soft inputs contribute 0 with an `unknown` reason.
- Grade A–F from the integer score; disqualified funders are grade `DQ`, `eligible: false`, score 0.
- Copy: “Scores describe funder fit, not approval odds.”
- Snapshots persist policy, underwriting, completeness, deal, and per-funder criteria versions. GET reports `stale` after those versions (or aggregate `computedAt`) change; POST reanalyze writes a new row. Unchanged retry keeps snapshot identity.
- Reads: `deals:read`. Writes: `deals:write`. `intake:write` is 403. Cross-workspace deals are 404.

## UI

`ScorePanel({ dealId })` covers loading, empty, error, success, stale, and DQ-not-selectable. Conductor mounts it on the deal Underwriting tab.

## Local vs live gates

Local/fixture Postgres plus synthetic deal/funder inputs prove DQ, reproducibility, unknown-not-pass, snapshot staleness, and permission envelopes. No external provider is involved. There is no live-integration gate for this ticket.
