# MIC-101 acceptance — Team performance, distributions and company profit

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-101
**Synthetic date:** January 2026, workspace timezone `America/New_York`.
**Depends on:** MIC-104 unique totals and `SHARED_REP_ATTRIBUTION`.

## Metric definitions

| Metric | Definition |
| --- | --- |
| Unique deals | Company and manager totals count each deal once. Shared originator/closer assignments still give each user full row credit. |
| Collected revenue | Received commission and fee amounts on non-void ledger payments. Void and reversed rows are omitted. |
| Expected revenue | Expected commission and fee amounts on non-void ledger payments, including unpaid expected rows. |
| Paid distributions | Paid recipient distribution rows on non-void payments. A 60/40 split sums to the unique company total. |
| Gross contribution | Collected commission and fees minus paid distributions. Other operating costs are not subtracted. |
| Other operating costs | Lead-batch purchase costs in the period. Displayed separately from gross contribution. |
| Reversal evidence | Voided payments, reversed funding events, and accounting adjustments stay listed with record ids, timestamps, amounts, and correlation ids. |

Company totals consume `getRepFunnelReport` `totals` (unique deals). Do not `sum(reps)`.

## Synthetic scenario (January 2026, `basis=event`, `from=2026-01-01`, `to=2026-01-31`)

| Deal | Reps | Notes |
| --- | --- | --- |
| Harbor Bakery | Ada originator + Beau closer | Funded. Commission $3,200 received, split 60/40 paid. Fee $200 received. Extra expected fee $100 − $10 adjustment. Duplicate $50 fee voided. |
| Beacon Bistro | Ada | Created only. |
| December Cohort Inc | Cara | Created Dec 2025, submitted Jan 2026. |
| Unassigned Merchant | none | Created only. |
| Reversed Funding | Ada | Funding reversed; not funded. Evidence row with correlation id. |
| Other workspace / March | — | Excluded. |

Morgan manages Ada, Beau, and Cara. Lead batch purchased 2026-01-05 costs $500.

Expected unique company totals: created **4**, submitted **3**, funded **1**. Ada created **3**, Beau created **1**; sum **> 4**. Morgan unique created **3** (Harbor counted once). Collected revenue **$3,400**, paid distributions **$3,200**, gross contribution **$200**. Operating costs **$500** stay out of gross. Expected revenue **$3,490**, expected gross **$290**.

Voiding the Harbor fee drops collected revenue to **$3,200** and collected gross to **$0**, and adds evidence for `pay-harbor-fee` with correlation id `corr-void-harbor-fee`.

## UI and API

- States: loading, empty, validation (`from` after `to` / missing basis / invalid recognition), success, failure with Retry (same filters; GET creates no records).
- Collected/expected recognition toggle. User/manager grouping toggle.
- Missing `viewPaymentTable`: `200` with Restricted revenue, distributions, gross contribution, and operating costs, **not** `$0`. Unique deal counts remain.
- Rep/manager sessions: `403`. Reports feature off: `403 reports_disabled`. Unauthenticated: `401`. Direct API uses the same rules as the UI. Logs do not print session tokens.

## Checks

`cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-team-profit.test.ts` — pass.
