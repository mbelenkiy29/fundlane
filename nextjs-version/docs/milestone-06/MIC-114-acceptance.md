# MIC-114 acceptance — Funder analytics and commission performance

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-114
**Synthetic date:** January 2026, workspace timezone `America/New_York`.

## Attribution (frozen)

`FUNDER_ANALYTICS_ATTRIBUTION` in `src/lib/mca/reports/funder-analytics.ts`.

| Metric | Identity | Notes |
| --- | --- | --- |
| Submissions | Unique send identity (`job_id`, else `deal_submissions.id`, else `manual:{id}`) | Job + cache row for the same job count once. A resubmit is a second submission. |
| Unique merchants | Unique `deal_id` among those submissions | Harbor submitted to North and South is **one** merchant in totals and one per funder row. |
| Approvals | Unique `(funderId, submissionKey)` | `submissionKey` canonicalizes job id / `deal_submissions` id / offer `submission_id`. **Revisions do not multiply.** Missing `amountCents` stays unknown, not `$0`. |
| Fundings | Committed `mca_funding_events` | Reversed/corrected events are omitted. |
| Collected commissions | Non-void `mca_accounting_payments` `type=commission` `received_amount_cents` | Must equal the payment ledger for the same filters. Fees are drilldown-only. |

Denominators: approval rate = approvals / submissions; funding rate = fundings / approvals. Zero denominators are `N/A`.

## Filters

- Admin/super_admin + `features.reports` + reports page visibility.
- `basis` required: `event` or `cohort`.
- `from` / `to` inclusive `YYYY-MM-DD` in workspace tz. Omit both for **lifetime** (unknown dates included). Date-filtered event views exclude undated rows.
- Optional `funderIds`, `membershipIds`, `sourceIds`, `batchIds`. IDs outside the workspace are `422 invalid_filter`.
- Incomplete periods (`to` missing, today, or future, including lifetime) are labeled.

## Channels

`mca_submission_jobs.route_kind` / `deal_submissions.route_kind`: `api` and `email` are first-class. Portal, webhook, manual, and unknown roll into `other`.

## Synthetic scenario (January 2026, `basis=event`, `from=2026-01-01`, `to=2026-01-31`)

| Deal | Funder / channel | Notes |
| --- | --- | --- |
| Harbor Bakery | North email ×2 (original + resubmit) and South API | One offer with **3 revisions**, funded $40,000, commission $3,200 received Jan 28; fee $100 received; void $500 commission omitted |
| Twin Merchants LLC | North email | Submitted only — North submissions 3 vs unique merchants 2 |
| Unknown Terms LLC | South API | Approved with missing amount |
| December Cohort Inc | West email | Created Dec 2025, submitted Jan 2026 |
| Timezone Edge | West email | `2026-01-15T04:00:00.000Z` → **2026-01-14** ET |
| Late Pay LLC | East API | Funded Jan 25, commission $800 received **Feb 5** |
| Reversed Funding | South API | Funding reversed; not funded |
| Beacon Bistro | Unattributed, no timestamp | Lifetime only |
| March Deal | East API in March | Lifetime only |
| Other workspace | — | Excluded |

Expected January event totals: submissions **9**, unique merchants **7**, approvals **4** (one unknown amount, known $59,000), fundings **2** ($50,000), collected commissions **$3,200**. North: 3 submissions / 2 merchants / 1 approval (revisionCount 3) / $3,200. South: 3 submissions / 2 approvals / 0 fundings. West funding rate **N/A**. API **4** / email **5**. Ledger `sum(received_amount_cents)` for non-void commissions in January equals $3,200. Lifetime collected commissions **$4,000**. Cohort January includes the February Late Pay receipt.

## UI and API

- States: loading, empty, validation (`from` after `to` / missing basis), success, failure with Retry (same filters; GET creates no records).
- Missing `viewPaymentTable`: `200` with Restricted commissions, **not** `$0`.
- Rep/manager: `403`. Reports feature off: `403 reports_disabled`. Unauthenticated: `401`. Nested GET `/api/mca/reports/funders/[funderId]` uses the same rules. Logs do not print session tokens.

## Checks

`cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-funder-analytics.test.ts` — pass.
