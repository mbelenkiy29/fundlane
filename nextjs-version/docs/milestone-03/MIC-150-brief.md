# MIC-150 brief — Review email and secure selection

Ticket: https://linear.app/michael-belenkiy/issue/MIC-150/funder-analysis-review-email-and-secure-selection-action

Depends on MIC-148. MIC-121 is **out of scope**. Exclusive: `src/lib/mca/underwriting/review-mail.ts`, `src/app/api/mca/underwriting/review/**`, `src/app/(dashboard)/review/[token]/page.tsx`, `src/components/mca/underwriting/review-panel.tsx`, `tests/underwriting-review.test.ts`, acceptance+report.

Exception: you may add template `"funder_analysis_review"` to `src/lib/mca/email.ts` only.

5-minute HMAC token. Expired/forwarded link cannot submit. Confirm revalidates permissions, completeness ready, score freshness. Approval binds to that snapshot only. Recipients from membership emails / configured roles — no sender-connection UI.

No git. No subagents. TDD.
