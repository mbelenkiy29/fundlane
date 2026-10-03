# Deal advance estimates (formula v1)

`GET /api/mca/underwriting/estimates/[dealId]` returns a rough advance range for each lender that lender fit marks as `matched`. The result is labeled **"Estimate — not an offer"**. It is deterministic, uses no AI and is never stored. It does not read or write the offer tables, and real lender offers are separate. Lenders set the actual terms.

Code: `src/lib/mca/underwriting/estimates.ts` (pure formula and constants), `estimates-loader.ts` (input loading), and `src/components/mca/underwriting/estimates-panel.tsx` (shown on the Underwriting tab after Lender fit).

## Flag

Set `MCA_DEAL_ESTIMATES_ENABLED` to exactly `true` to turn on both the API and the panel. Any other value, or leaving it unset, means the route returns 404 and the panel is hidden.

## Access

The route uses the same `requireScoreActor(request, "read")` as lender fit (session or API key with `deals:read`). The loader calls `getLenderFit`, which checks deal visibility. Lender fit applies no finance redaction, so estimates don't either.

## Inputs

| Input | Source |
|---|---|
| Average monthly deposits (M) | Mean of the latest up-to-3 statement months with known deposits. Months are restricted to included checking months in the closed lookback window (`includedMonths` + `resolveUnderwritingWindow`). Multiple accounts in the same month are summed. A period with any unknown deposit total is dropped. |
| Existing daily payments | Sum of `estimatedPayment` on non-dismissed existing positions, with negative values counted as 0. |
| Lender min/max funding | Criteria `requested_amount` `min`/`max` (numeric, not unspecified). |
| Lender term | Criteria `term`, converted from the rule's unit (`days` × 12/365, `months`, `years` × 12); rules with any other unit, or a zero or negative value, are ignored with a warning. Uses the `eq` value, otherwise the midpoint of `min` and `max`, otherwise the single bound, then rounds and clamps to 2–18 months with a warning. Lender-fit scoring converts hard `term` rules differently; see [Hard term rules in lender-fit scoring](#hard-term-rules-in-lender-fit-scoring). |
| Broker assumptions | Query params `factor`, `termMonths`, `frequency` (`daily`/`weekly`), `holdbackPct`. Non-numeric values or an unknown frequency return 422. Out-of-range values are clamped, with a warning. |

Precedence for each assumption: broker, then lender (term only), then default. `assumptionsSource` records which one was used.

## Formula

1. D = M / 21; availableDaily = holdbackPct × D − existingDailyPayments. If availableDaily ≤ 0, the status is `no_capacity`.
2. payments = round(termMonths × 21) for daily, or round(termMonths × 4.33) for weekly.
3. capacityMaxAdvance = availableDaily × termMonths × 21 / factor.
4. high = min(1.0 × M, capacityMaxAdvance, lender max), rounded down to $500. If that comes out as $0, the status is `no_capacity`; the reason names the lender maximum when that maximum is itself under $500.
5. If a lender min exists and high < min, the status is `below_lender_minimum`.
6. low = max(min(0.5 × M, high) rounded down to $500, lender min).
7. payback = advance × factor; payment per period = payback / payments, rounded to cents. Both are computed for low and high. If the payment count isn't positive or any amount isn't finite, the status is `insufficient_data` (never $0 or Infinity).

Worked example: M = $60,000, no positions, defaults. D = $2,857.14, available = $342.86/day, capacity = $32,000. The range is $30,000–$32,000, the payback is $40,500–$43,200, and the payment is $321.43–$342.86/day over 126 payments.

## Defaults and why

| Constant | Value | Why |
|---|---|---|
| `BUSINESS_DAYS_PER_MONTH` | 21 | Daily MCA debits run on ACH business days, which is about 21 per month. |
| `WEEKS_PER_MONTH` | 4.33 | 52 weeks / 12 months. |
| `REVENUE_LOW_MULTIPLE` / `REVENUE_HIGH_MULTIPLE` | 0.5× / 1.0× M | First-position advances are commonly sized at roughly half to one month of revenue. |
| `factor` | 1.35 (1.10–1.60) | Sits in the middle of the usual 1.1–1.5 buy-rate band. The clamp allows for higher-risk paper. |
| `termMonths` | 6 (2–18) | Six months is a typical short MCA term. |
| `holdbackPct` | 0.12 (0.05–0.25) | Daily remittance usually takes about 8–15% of receipts. This value caps **all** MCA payments together, so stacking can't push the total above it. |
| `ROUND_TO` | $500, down | Rounding down keeps estimates conservative. |
| `MAX_MONTHS_USED` | 3 | Recent months reflect current volume. |

## Output

`{ label, formulaVersion: 1, asOf, lenders: LenderEstimate[] }`. Each lender entry has `funderId`, `funderName`, `status` (`estimate` | `insufficient_data` | `no_capacity` | `below_lender_minimum`), `reason`, `advanceLow`/`High`, `factor`, `termMonths`, `frequency`, `payments`, `paymentLow`/`High`, `paybackLow`/`High`, `inputs { avgMonthlyDeposits, monthsUsed, existingDailyPayments, holdbackPct }`, `assumptionsSource`, and `warnings`. For any status other than `estimate`, every amount, factor, term and payment count is `null`. A missing or ≤ 0 M gives `insufficient_data` ("No analyzed bank statements").

## Known gaps (shown as warnings)

- **Transfers and funding credits aren't separated.** Statement extraction keeps the printed deposit total. If a used month has a `transfer:` or `mca_credit:` warning, the estimate says "Deposits may include transfers or funding credits".
- **Position cadence isn't stored.** Each `estimatedPayment` is treated as a **daily** debit, which is the most conservative reading ("Existing position payments assumed daily"). Lender scoring treats the same value as monthly. Positions without an amount are excluded, with a count. No positions at all gives "Existing positions not detected; estimate assumes none".
- **No lender factor criteria exist.** Factor always comes from the broker or the default.

## Hard term rules in lender-fit scoring

Lender-fit scoring (`lenderTermRuleWholeMonths` in `estimates.ts`, used by `scoring.ts`) does **not** use the estimate conversion above. It compares the deal's requested term against the lender's real term, never clamps it, and rounds toward the lender's side so a deal can't fall outside what the lender allows. Days use integer math only; the estimates' 12/365 float factor is never used.

| Rule | Conversion | Examples |
| --- | --- | --- |
| `max` in days | 30-day month, rounded down: `floor(days / 30)` | 180 days = 6, 200 = 6, 365 = 12 |
| `min` in days | 365/12 month, rounded up: `ceil(days × 12 / 365)` | 90 days = 3, 200 = 7, 365 = 12 |
| `eq` in days | Whole months only: `days / 30` or `days × 12 / 365`, whichever is whole | 180 days = 6, 365 = 12; 200 days matches no whole-month request |
| `months` / `years` | As given / × 12, with the same rounding (max down, min up) | a 24-month max stays 24 and passes a 20-month request |

A max under 30 days, a zero or negative value, or a unit that isn't `days`, `months` or `years` gives `unknown` (needs review), never pass or fail. Unknown-term reasons name the rule's own limit (minimum or maximum). In the criteria panel, changing a rule's field to Term resets its unit to months.
