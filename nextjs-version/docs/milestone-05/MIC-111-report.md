# MIC-111 report — Reverse consolidation and weekly distributions

Implementer A1. Exclusive files only. Linear was not marked Done. Production was not migrated. No bank transfer, ACH, or comms job was registered.

## What shipped

Reverse consolidation is a deal-scoped product record that **references existing advances** and attaches a versioned Monday weekly expected-distribution schedule. Installments are accounting rows (`expected` / `paid` / `void`), not collections and not transfers.

| Surface | Behavior |
| --- | --- |
| `createReverseConsolidation` | Same-workspace deal + non-reversed advances; Monday `YYYY-MM-DD` via UTC noon; MIC-103 split template version; idempotent on `(workspace, idempotency_key)` |
| `runDistributionSchedules` | Materializes all Monday dates for **active** schedules; unique `(workspace, schedule_id, schedule_version, occurrence_date, recipient_membership_id)`; paused/cancelled are no-ops |
| Pause | `status=paused`; run inserts nothing |
| Cancel | `status=cancelled`; voids unpaid; paid immutable |
| Exception | Voids one unpaid occurrence (all recipients on that date, or one recipient) |
| Amend | New version; voids unpaid of previous version; paid stay; regenerates unpaid dates for the new version (skips paid recipient/date pairs) |
| Mark paid | `expected` → `paid` only; `paid_at` is not rewritten on retry |

Split cents use `calculateSplitSnapshot` (largest remainder, already in MIC-103). Frozen 60/40 of `100000` cents is `60000` / `40000`.

## Frozen example (plan-validated)

- Four Monday installments of `100000` cents starting `2026-10-05` → `2026-10-05`, `2026-10-12`, `2026-10-19`, `2026-10-26`.
- Split template `6000` / `4000` bp.
- First run inserts **8** rows (4 dates × 2 recipients). Per date `100000` cents; schedule total `400000` cents.
- Second run inserts **0** extra rows (`skipped=8`).
- Pay both recipients on `2026-10-05`; amend remaining to start `2026-10-12` count `3`; paid rows unchanged; six v1 unpaid rows voided; six v2 expected rows regenerated.
- Cancel voids remaining unpaid; two paid rows keep original `paid_at` and amounts.

## Authorization

Routes use `requirePaymentActor` (Payments feature + page + `viewPaymentTable`) and `assertTrustedMutation` on writes. Direct GET without those flags returns 403 (same pattern as MIC-112).

## Logs

Audit metadata includes ids, counts, occurrence dates, and `noBankTransfer: true`. No secrets, tokens, or document bytes.

## Verification

```bash
cd nextjs-version
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone05-schedules.test.ts
```

Result: **7 passed, 0 failed** (disposable DB `milestone05_schedules` via `tests/helpers/postgres-test-db.mjs`; migration `0014_youthful_silver_samurai` applied by the helper).

## NEEDS_CONDUCTOR

A1 did not edit conductor-owned files. Remaining integration:

1. **Mount UI:** render `<SchedulesPanel />` on `/payments` below the existing ledger (`src/app/(dashboard)/payments/page.tsx`).
2. **Export:** add `export { SchedulesPanel } from "./schedules-panel"` in `src/components/mca/accounting/index.ts`.
3. **Schema registry:** `src/lib/mca/db/milestone05-schedules.ts` is not imported from `db/schema.ts`. Tests apply drizzle `0014` directly; future `pnpm db:generate` still needs the tables registered.
4. **Linear:** do not mark MIC-111 Done until conductor verifies typecheck, the payments mount, and acceptance. Remaining product gate: **none for software**. No bank transfer, by design.
