# MIC-163 brief — Explainable scoring

Ticket: https://linear.app/michael-belenkiy/issue/MIC-163/explainable-funder-scoring-ranking-and-disqualifications

Depends on MIC-170 + MIC-172 + MIC-91. Exclusive: `src/lib/mca/underwriting/scoring.ts`, `policy.ts`, `snapshot-repository.ts`, `src/app/api/mca/underwriting/scores/**`, `src/components/mca/underwriting/score-panel.tsx`, `tests/underwriting-scoring.test.ts`, acceptance+report.

Hard DQ before score. Same inputs + policyVersion → same scores. Grade A–F or DQ. Copy: fit not approval odds. DQ cannot be auto-selected. Persist snapshots.

No git. No subagents. TDD.
