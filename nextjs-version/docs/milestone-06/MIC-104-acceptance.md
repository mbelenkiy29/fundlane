# MIC-104 acceptance — Rep performance funnel and funding report

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-104
**Synthetic date:** January 2026, workspace timezone `America/New_York`.

## Shared-rep attribution (frozen for MIC-101)

MIC-101 must consume `totals` from this report, never the sum of `reps`.

| Rule | Behavior |
| --- | --- |
| Deal credit | **Full credit per assigned rep.** Every `deal_assignments` membership (`originator` and `closer`) receives the unique-deal counts and amounts on their row. Two originators each show the deal as `1`. |
| Company / unfiltered totals | **Unique deals.** Harbor credited to Ada and Beau still counts as **one** created/submitted/approved/funded deal in `totals`. |
| Unassigned | Deals with no assignments appear on the Unassigned row and in unique totals. |
| Distributions | **Recipient membership** on `mca_payment_distributions` (status `expected` or `paid`, payment not `void`). A 60/40 split is $1,920 / $1,280, and those cents **sum** to the unique company total. Void rows are omitted. |
| Do not | Fractionally split deal counts. Do not invent $0 when payment permission is off. Do not count a five-funder package as five submitted deals. |

`SHARED_REP_ATTRIBUTION` in `src/lib/mca/reports/rep-funnel.ts` is the machine-readable form of this table.

## Filters

- Admin/super_admin + `features.reports` + reports page visibility.
- `basis` is required: `event` (stage timestamp in range) or `cohort` (deal created in range; later stages still count).
- `from` / `to` are inclusive `YYYY-MM-DD` in the workspace timezone. Date-only stamps are not shifted.
- Optional `membershipIds`, `funderIds`, `sourceIds`, `batchIds`. IDs outside the workspace are `422 invalid_filter`.
- Incomplete periods (`to` missing, today, or future) are labeled. Zero denominators are `N/A`.

## Unique-deal stages

| Stage | Counted when | Amount | Timestamp |
| --- | --- | --- | --- |
| Created | Deal exists | `requested_amount` → cents, else unknown | `deal_activity` created, else `deals.created_at` |
| Submitted | Unique `deal_id` with a real send (`deal_submissions` sent/approved/declined/errored, sent jobs, manual submissions, or activity `submitted`/`resubmitting`) | Requested amount | First submitted activity / job / manual `historical_at` |
| Approved | Unique deal with an offer/approval (submissions, `mca_offers`, manual approved/funded, activity `offer`/`contract`/`funded`) | Selected/funded revision cents; missing terms stay **unknown**, not $0 | First approval stamp |
| Funded | Unique deal with a **committed** `mca_funding_events` row | Sum of committed `amount_cents` | `funded_at` |
| Reversed funding | Excluded from funded | — | — |

A deal submitted to five funders is **one** submitted deal. Funder filters still unique-count that deal.

## Synthetic scenario (expected January 2026, `basis=event`, `from=2026-01-01`, `to=2026-01-31`)

| Deal | Reps | Notes |
| --- | --- | --- |
| Harbor Bakery | Ada originator + Beau closer | Five funder submissions, approved $40,000, funded $40,000, $3,200 commission split 60/40 paid |
| Beacon Bistro | Ada | Created only |
| Unknown Terms LLC | Ada | Approved with no amount |
| December Cohort Inc | Cara | Created Dec 2025, submitted Jan 2026 |
| Unassigned Merchant | none | Created only |
| Timezone Edge | Ada | `2026-01-15T04:00:00.000Z` → **2026-01-14** ET |
| Reversed Funding | Ada | Funding reversed; not funded |
| Other workspace / March | — | Excluded |

Expected unique totals: created **6**, submitted **4**, approved **3** (one unknown amount, known $49,000), funded **1** ($40,000). Ada created **5**, Beau created **1**; sum **> 6**. Harbor appears once in submitted drilldown. Distributions: Ada $1,920 + Beau $1,280 = $3,200. Cara-only January conversions created→submitted are **N/A**. Cohort December: created 1 and submitted 1 (the December deal). Drilldown length and known cents equal `totals` for the same filters.

## UI and API

- States: loading, empty, validation (`from` after `to` / missing basis), success, failure with Retry (same filters; GET creates no records).
- Missing `viewPaymentTable` (or payments page/feature): `200` with `paymentsVisible: false` and Restricted distributions, **not** `$0`.
- Company totals flag hides unique money totals; counts remain on the API `totals` object for MIC-101.
- Rep/manager sessions: `403`. Reports feature off: `403 reports_disabled`. Unauthenticated: `401`. Direct API uses the same rules as the UI. Logs do not print session tokens.

## Checks

`cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-rep-funnel.test.ts` — pass.
