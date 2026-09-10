# MIC-116 acceptance — Lead source CAC and ROI

Verified against Linear MIC-116 and `docs/milestone-06/MIC-116-brief.md`. Synthetic fixtures only. No production rows were changed.

## Linear boxes

| Criterion | Result |
| --- | --- |
| A zero-cost batch displays undefined ROI rather than infinity | Pass. `batch-zero` has `cost_cents = 0`, `collectedRoi = null`, display `Undefined`. Value is not `Infinity` and is not coerced to `0`. |
| Renewals and repeat fundings follow the documented attribution policy without silently inflating acquisition counts | Pass. See attribution table. January paid pack stays 3 acquired / 2 funded deals / 1 funded merchant after a same-EIN renewal deal and a second committed funding on Alpha. |
| Realistic synthetic scenario and expected output | Pass. Excel paid / zero / missing packs, Other source, unassigned, December cohort, March exclusion, other workspace. |
| Loading, empty, validation, success and failure; retries preserve identity | Pass. `LeadRoi` states; GET creates no records; Retry reuses the same filters. |
| API permissions match UI; logs exclude secrets | Pass. Rep/manager 403, unauthenticated 401, reports feature off `403 reports_disabled`, foreign source `422`. Session token is not logged. |

## Attribution (frozen)

| Rule | Behavior |
| --- | --- |
| Acquisition identity | Latest `mca_deal_acquisition_events` row per deal (`listLatestAcquisitions`). |
| Acquired deal | Non-renewal deal with a latest source or batch. Unique `deal_id` counts. |
| Renewal | `mca_renewal_actions.renewed_deal_id` is **not** an acquisition, even if assigned to the same batch. Shown on follow-on drilldown. |
| Repeat funding | Extra committed `mca_funding_events` on an acquired deal do **not** increment funded-deal or funded-merchant counts. Commission on those events **is** included in collected. |
| Funded deal | Unique acquired deals with ≥1 committed funding event. |
| Funded merchant | Unique `ein_cipher` among funded acquired deals; if EIN is missing, `deal:{id}`. |
| Purchase cost | Current `lead_batches.cost_cents`. `null` = missing (warning, CAC/ROI omitted). `0` = real zero (CAC `$0` when funded > 0; ROI undefined). Cost is not pro-rated on event basis. |
| Collected commission | Sum of `received_amount_cents` on non-void `type=commission` payments for **acquired** deals. |
| Expected-value ROI | `(expected_amount_cents − purchase cost) / purchase cost`, labeled `expected_value`. |
| Follow-on ROI | Adds renewal-deal commission, labeled `including_follow_on`. Not mixed into collected ROI. |
| Cohort basis | Inclusive `purchased_on` (else acquisition/created calendar date in workspace tz). Later stages still count. |
| Event basis | Stage timestamps in range. December-acquired / January-submitted appears in submitted, not acquired. |
| Zero denominator | Conversion rate and CAC are `N/A`, never infinity or `0`. |

`LEAD_ROI_ATTRIBUTION` in `src/lib/mca/reports/lead-roi.ts` is the machine-readable form of this table.

## Synthetic scenario (January 2026, `basis=cohort`, `from=2026-01-01`, `to=2026-01-31`)

Workspace tz `America/New_York`.

| Deal | Batch | Notes |
| --- | --- | --- |
| Harbor Alpha LLC | January paid pack ($1,000) | EIN `ein-alpha`. Funded twice (repeat $300 commission). Collected $2,300. |
| Harbor Twin LLC | same | Same EIN. Funded. Expected $400, not collected. |
| Beta Submitted LLC | same | Submitted only. |
| Harbor Renewal LLC | assigned to paid pack | Converted renewal of Alpha. Collected $500. **Not** an acquisition. |
| Gamma Zero LLC | Zero-cost pack ($0.00) | Funded. ROI undefined. |
| Delta Missing LLC | Missing-cost pack (blank) | Submitted. Warning; CAC/ROI omitted. |
| Echo Other LLC | Other January pack ($200) | Funded. Collected $100. ROI −50%. |
| Unassigned Merchant | none | Excluded from CAC. |
| December Cohort Inc | December pack | Outside January cohort; submitted in January on event basis. |
| March Deal / other workspace | — | Excluded. |

Paid pack expected: acquired **3**, submitted **3**, approved **2**, funded deals **2**, funded merchants **1**, cost/deal **$500**, cost/merchant **$1,000**, collected ROI **+130%**, expected-value **+170%**, including follow-on **+180%**.

## Checks

```bash
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-lead-roi.test.ts
```

10 passed on a disposable Neon database from `tests/helpers/postgres-test-db.mjs`.

## Remaining gates

None.
