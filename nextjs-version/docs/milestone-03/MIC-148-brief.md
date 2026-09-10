# MIC-148 brief — Analysis modes

Ticket: https://linear.app/michael-belenkiy/issue/MIC-148/configurable-automatic-analysis-review-and-submission-modes

Depends on MIC-163 + MIC-164. MIC-166 is **out of scope**. Exclusive: `src/lib/mca/underwriting/analysis.ts`, `analysis-repository.ts`, `src/app/api/mca/underwriting/analysis/**`, `src/components/mca/underwriting/analysis-panel.tsx`, `tests/underwriting-analysis.test.ts`, acceptance+report.

Default `review_first`. `analyze_only` never calls `queueSubmissions` and never changes selection. `automatic_send` requires admin enablement and MUST call `queueSubmissions` from `src/lib/mca/underwriting/submission-port.ts` (always `submission_unavailable` today). Snapshot settings per run. Record why each destination was selected/excluded/blocked.

No git. No subagents. TDD.
