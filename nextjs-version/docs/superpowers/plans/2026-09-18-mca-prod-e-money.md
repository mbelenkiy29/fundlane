# MCA Prod E — Remittance, Renewals, Commission Visibility, Money Bugs

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development or executing-plans. Migration is **`0044_money_remittance.sql`**. Create `actorCanViewCompanyFinancials` here; Team F must import it.

**Goal:** Leftover $0 stays $0; receipts match by amount; one workspace timezone; renewal uses collected/payback; funding retries cannot change money; factor math is integer millionths; book/advance JSON hides money without `canViewCompanyFinancials`.

**Architecture:** Keep fixed ACH-style calendars and separate broker vs merchant ledgers. Do not build ACH, lockbox, syndication, holdback %, bank holidays, or first-pay offset.

**Spec:** `2026-09-18-mca-prod-master.md`

## Locked decisions

See master. Historical funding may omit schedule (warning, no installments). Live/manual funding without explicit `paymentCount`+`frequency`+`calendarConvention` → 422 `funding_schedule_required`. Term months is never a payment count. Default writes off **unpaid expected** commission only.

## Task 1: Millionths factor + last installment 0

**Files:** `accounting/money.ts`, `calculations.ts`, `advances/performance.ts`, `db/merchant-remittance.ts`, start `0044` with `amount_cents >= 0`.

```ts
export function ratioFromMillionths(millionths: number): DecimalRatio
export function multiplyCentsByRatio(cents: number, ratio: DecimalRatio): number
```

Replace `remaining || periodicPayment` with `remaining` (0 valid).

- [ ] Tests: payback 9000 / 10×1000 → last amount 0, sum 9000. `factorRateMillionths: 1_350_000` on 4_000_000 → payback 5_400_000. String `factorRate: "1.25"` still works.
- [ ] Commit: `fix(accounting): integer factor millionths and zero leftover installment`

## Task 2: Workspace timezone

Thread `timeZone` through `estimateScheduledPaidIn`, `generateExpectedInstallments`, `persistInstallments`, `recordReceipt`, `runMissedPaymentAlerts`. Add `received_on` (workspace calendar date) on receipts. Missed SQL uses `received_on`, not `left(received_at,10)`. Book detail uses `calendarDateInZone(..., timezone)`, not `slice(0,10)`.

- [ ] Test: `2026-09-13T02:00:00.000Z` → NY `2026-09-12`, UTC `2026-09-13`.
- [ ] Commit: `fix(remittance): use workspace timezone for calendars and receipts`

## Task 3: Amount-aware receipts + void API

```ts
export function collectedTowardInstallment(...): number
export function installmentSatisfied(amountCents: number, collectedCents: number): boolean
export async function voidReceipt(actor, advanceId, receiptId, input: { reason: string; idempotencyKey: string }): Promise<ReceiptRow>
```

`$1` on a `$1,000` due date does not clear. `$0` last installment is never missed. Void: manager/admin session; replay ok; reps 403. Same idempotency key + different amount → 409.

`PATCH /api/mca/deals/book/:advanceId/receipts/:receiptId` `{ status: "void", reason, idempotencyKey }`.

- [ ] Commit: `fix(remittance): match receipts by amount and allow void`

## Task 4: Funding fingerprint + explicit schedule

Replay compares `amountCents`, `commissionCents`, `feeCents`, canonical splits hash. Different money → 409 `funding_key_conflict`. Pass `factorRateMillionths` into `calculateOffer` (no IEEE string). Live/manual missing schedule → 422. Historical missing schedule still commits.

- [ ] Commit: `fix(funding): bind idempotency to money and require an explicit schedule`

## Task 5: Renewal from collected

`renewalEligibleFromReceipts` uses collected/payback only. No receipts → not eligible. Skip reversed / default / in_collections / closed. Book still shows labeled calendar estimate beside actual collected. Rewrite MIC-105 to seed receipts or expect 0 without them.

- [ ] Commit: `fix(renewals): eligibility uses collected payback not calendar estimate`

## Task 6: Write off unpaid expected commission on default

`0044` add `written_off` to payment and distribution status checks. `recordAdvanceStatus("default")` writes off `expected` commission with `received_amount_cents=0` and expected child distributions. Paid distributions stay paid. Totals skip `written_off` like `void`.

- [ ] Commit: `fix(accounting): write off unpaid expected commission on default`

## Task 7: Hide book + advances money

```ts
export function actorCanViewCompanyFinancials(role, actionVisibility): boolean
```

Omit principal, payback, factor, balance, % paid, payment amount, commission, collected, scheduled paid-in when false. Add `financialsHidden: true`. UI must not render `$0`.

- [ ] Commit: `fix(book): omit financial fields without viewCompanyFinancials`

## Task 8: Home KPI honesty

Rename strip “Broker collections today”. Add `merchantCollectionsToday` from receipts (`received_on === today`). Keep 8-card strip. Receipts must not inflate broker `collectionsToday`.

- [ ] Commit: `fix(home): label broker collections and report merchant remittances separately`

## Task 9: Team profit unassigned ledger

Unassigned deals’ commission/fee land on the unassigned row, included in company totals. New test with its own date range so MIC-101 frozen 340_000 stays.

- [ ] Commit: `fix(reports): include unassigned-deal ledger money on the unassigned profit row`

## Task 10: Follow-ups (document only)

ACH, lockbox, syndication, holdback, holidays, first-pay offset, paid-clawback — comments in hooked files + this plan. Do not implement.

## Verification

```bash
cd nextjs-version
node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 \
  tests/milestone05-accounting-core.test.ts tests/deals-book.test.ts tests/deals-book-db.test.ts \
  tests/milestone05-accounting-db.test.ts tests/milestone05-offers-funding.test.ts \
  tests/home-kpis.test.ts tests/home-kpi-strip.test.ts tests/milestone06-team-profit.test.ts
```

## Overlap with F

F imports `actorCanViewCompanyFinancials`. Redaction contract: **omit keys**, do not null-to-zero.
