# MIC-114 brief — Funder analytics and commission performance

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-114
**Depends on:** MIC-112, MIC-113 (done)

Exclusive: `src/lib/mca/reports/funder-analytics.ts`, `src/app/api/mca/reports/funders/**`, `src/components/mca/reports/funder-analytics.tsx`, `tests/milestone06-funder-analytics.test.ts`, docs.

Frozen: submissions / unique merchants / approvals / fundings / collected commissions by funder. Revised offers do not double-count approvals. Earned totals reconcile to the payment ledger. Incomplete periods labeled.
