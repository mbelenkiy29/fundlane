# MCA Prod B — Underwriting Math, Completeness, Hard DQ, Positions

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development or executing-plans. Migration is **`0041_underwriting_policy_v2.sql`**. Do not edit `submissions/queue.ts` (Team C calls your send-gates).

**Goal:** Closed-month completeness, unique-day NSF/neg, confirmed positions, conservative hard DQ (ADB/amount/term/deposit count), NAICS prefix, real default flag, no automatic send without completeness + confirmed positions.

**Architecture:** Keep deal → statements → aggregate → score → analysis → queue. Extract `lookback.ts`, `aggregates.ts`, `send-gates.ts` so `statements.ts` and `statement-repository.ts` cannot drift.

**Tech Stack:** TypeScript, Drizzle `0041`, node:test, existing DataMerch records.

**Spec:** `2026-09-18-mca-prod-master.md`

## Locked decisions

See master. Extra: deposits stay the revenue proxy (warnings only). DataMerch not required. `POLICY_VERSION = 2`. Rewrite tests that encoded NSF-sum / UTC current month / filename-ready.

## File map

| File | Role |
| --- | --- |
| `underwriting/policy.ts` | v2, expanded `HARD_DQ_FIELDS`, `AUTO_SELECT_GRADES` A/B/C |
| `underwriting/lookback.ts` | **Create.** Closed months in workspace TZ |
| `underwriting/aggregates.ts` | **Create.** Unique-day NSF, worst-month, confirmed positions |
| `underwriting/send-gates.ts` | **Create.** Completeness + proposed-position gate |
| `underwriting/{contracts,statement-extraction,statements,statement-repository,completeness,scoring,analysis,submission-port,review-mail,corrections}.ts` | Wire math + gates |
| `deals/{schema,validation,repository,service}.ts` | Optional `requestedTermMonths` |
| `drizzle/0041_underwriting_policy_v2.sql` | New columns |
| Tests | `underwriting-*.test.ts`, `funders-criteria.test.ts` |

## Task 1: Policy v2 + closed-month lookback

**Produces:**

```ts
export function closedLookbackMonths(count: number, timeZone: string, now?: Date): string[]
export function setUnderwritingNowForTests(now?: Date): void
```

Sep 18 2026 16:00Z in `America/New_York` + N=3 → `["2026-06","2026-07","2026-08"]`. Current month never in lookback.

- [ ] Tests in `underwriting-completeness.test.ts` freeze clock; assert missing codes; **no** `missing_statement_2026-09`.
- [ ] `POLICY_VERSION = 2`; add ADB/requested_amount/term/deposit_count to `HARD_DQ_FIELDS`.
- [ ] Completeness uses `getWorkspaceSettings().timezone` (default `America/New_York`).
- [ ] Commit: `feat(underwriting): policy v2 closed-month lookback in workspace timezone`

## Task 2: Extraction dates, warnings, real account kinds

**SQL (`0041`):** `mca_statement_months.nsf_dates`, `negative_dates`; aggregate `deposit_count`, `worst_month_nsf`, `warnings_json`; `deals.requested_term_months`.

- [ ] `accountKind` keeps savings/credit_card/loan (stop collapsing to unsupported).
- [ ] Prompt extracts `nsfDates` / `negativeDates` as `YYYY-MM-DD`. Warnings `transfer:` / `mca_credit:` — do not subtract from deposits.
- [ ] Rewrite MIC-179 savings test: kind is `savings`, still excluded from checking revenue.
- [ ] Commit: `feat(underwriting): persist NSF dates, deposit warnings, and real account kinds`

## Task 3: Shared aggregate math

**Produces:** `computeUnderwritingAggregate({ dealId, months, positions, window, version, computedAt })`

Rules: checking + not duplicate + valid period + in lookback + not current month. NSF = union of dates (fallback: known count on a **single** file; two+ files without dates → unknown). `positionCount` = confirmed only.

- [ ] Tests: same 5 days two accounts → 5; disjoint union; worst-month; skip unknown period and current month; proposed → count 0; dismiss does not inflate.
- [ ] Delete duplicate `computeAggregate` / `sumMetrics`. Both callers use `aggregates.ts`.
- [ ] Commit: `fix(underwriting): unique-day NSF, closed-month ADB, confirmed position counts`

## Task 4: Completeness coverage + DL + voided check

Coverage **only** from extracted checking rows on ready documents. Filename never covers. Require ready `driver_license` and `voided_check`.

Finding codes: `missing_application`, `missing_driver_license`, `missing_voided_check`, `missing_statement_YYYY-MM`, `unreadable_document`, `period_mismatch`, `unknown_statement_period`.

- [ ] Rewrite MIC-164 tests. Filename-only never ready. Partial app can be ready **if** DL+voided+checking months exist.
- [ ] Update completeness-panel copy.
- [ ] Commit: `fix(underwriting): completeness uses closed checking months, DL, and voided check`

## Task 5: Optional `requestedTermMonths`

Integer 1–60. Not in `submissionMissingFields`. Map `requested_term_months`. ScoringInputs: `termMonths`, `depositCount`, `depositUnknown`, `worstMonthNsf`, `proposedPositionCount`.

- [ ] Commit: `feat(deals): optional requestedTermMonths for term hard DQ`

## Task 6: `defaultFlag`

True only if confirmed position label matches `/\bdefaults?\b|\bdefaulted\b|\bslow[\s_-]?pay\b/i` **or** latest DataMerch check `status==="records"` with category Default / Slow pay. `deal.status === "default"` is **not** enough. Proposed OCR “default” does not count. Missing DataMerch → false (not unknown).

- [ ] Commit: `fix(underwriting): defaultFlag uses confirmed positions and DataMerch, not deal status`

## Task 7: Hard DQ extras + NAICS prefix

`evaluateHardRules` walks ADB, requested_amount, term, deposit_count. Unknown → DQ. Industry match: digit prefix (`7132` matches `713210`). Soft NSF uses worst-month; hard NSF uses window unique days.

- [ ] Tests: ADB 1000 vs min 5000 → DQ with **no** soft reasons. Amount 300k vs max 250k → DQ. Term 18 vs max 12 → DQ. Deposit count 2 vs min 6 → DQ. `713210` not_in `7132` → fail. Update `harborInputs` / `fitRules` so existing A-grade fixtures still pass.
- [ ] Commit: `feat(underwriting): hard DQ ADB/amount/term/deposit count and NAICS prefix match`

## Task 8: Auto-select C+ and send gates

```ts
export async function evaluateUnderwritingSendGates(actor: DealActor, dealId: string): Promise<UnderwritingSendGate>
```

`ok` iff latest completeness `ready` and `proposedPositionCount === 0`. `autoSelectableFunderIds` requires gate.ok and grade A/B/C. `runAnalysis` automatic_send blocked with reason `completeness_not_ready` | `positions_unconfirmed`. `submission-port.ts` refuses queue when gates fail. `review-mail` confirm 409 if proposed positions remain.

- [ ] Do not edit `submissions/queue.ts`.
- [ ] Commit: `fix(underwriting): auto-select C+ and block automatic_send without completeness and confirmed positions`

## Task 9: UI

Statement/score/completeness panels: unique-day NSF, worst-month, deposit count, “Confirmed positions”, aggregate warnings.

- [ ] `pnpm typecheck`
- [ ] Commit: `fix(underwriting): show unique-day NSF, confirmed positions, and deposit warnings`

## Task 10: Suite rewrite

Grep leftover `policyVersion, 1`, `nsfCount.value, 4`, `accountKind, "unsupported"`. Align analysis/review/intake-workflow fixtures (DL/voided/no proposed).

```bash
cd nextjs-version
node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 \
  tests/underwriting-statements.test.ts tests/underwriting-completeness.test.ts \
  tests/underwriting-corrections.test.ts tests/underwriting-scoring.test.ts \
  tests/underwriting-analysis.test.ts tests/underwriting-review.test.ts \
  tests/funders-criteria.test.ts tests/funders-scan.test.ts
pnpm typecheck
```

## Dependencies

- A: documents must be able to become `clean`. Stub scanners in tests.
- C: will call `evaluateUnderwritingSendGates` from `queueSubmissions`. Reason codes frozen: `completeness_not_ready`, `positions_unconfirmed`.
