# MIC-111 acceptance

Synthetic evidence only. Disposable database from `tests/helpers/postgres-test-db.mjs` (`milestone05_schedules`). No production migrate. No live transfer.

## Command

```bash
cd nextjs-version
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone05-schedules.test.ts
```

**7 passed, 0 failed** (duration ~26s).

## Criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Re-running the weekly scheduler creates each installment once | Pass | Frozen run inserted 8 rows; second run `inserted=0`, `skipped=8`, table count stayed 8. Unique key `(workspace_id, schedule_id, schedule_version, occurrence_date, recipient_membership_id)` from migration 0014. |
| Amendment changes future unpaid installments without rewriting paid entries | Pass | Both recipients on `2026-10-05` marked paid (`paid_at` `2026-10-05T12:00:00.000Z`, `60000`/`40000`). Amend to three Mondays from `2026-10-12`: paid rows unchanged including `paid_at`; six v1 unpaid rows `void`; six v2 expected rows for `10-12`/`10-19`/`10-26`. Paid retry does not rewrite `paid_at`. |
| Realistic synthetic scenario with expected output | Pass | Four Mondays from `2026-10-05`, `100000` cents, 60/40 via MIC-103 template → 8 expected rows, `60000`/`40000` per date, `100000` per date, `400000` total. `getUTCDay()===1` at UTC noon. Referenced two same-deal advances. |
| Loading, empty, validation, success, failure UI; retries preserve identity | Pass (software) | `SchedulesPanel`: loading spinner, empty copy, `role="alert"` / `role="status"`, Monday/amount/template validation, create/run/pause/cancel/amend/except/pay. Stable `idempotencyKey` until success. Create replay with same key returns the same consolidation; conflicting payload is 409. **NEEDS_CONDUCTOR** to mount the panel on `/payments` and export it from `components/mca/accounting/index.ts`. |
| Direct API permissions match Payments UI; logs exclude secrets | Pass | GET `/api/mca/accounting/schedules` is 403 when `viewPaymentTable` is false, Payments feature is off, or payments page is hidden; 200 when those flags match the Payments UI. Writes use `assertTrustedMutation` + `requirePaymentActor("write")`. Audit metadata has no secrets. |
| Pause is a run no-op | Pass | Paused schedule run inserted 0; 8 rows unchanged. |
| Exception voids one unpaid occurrence | Pass | `2026-10-19` → 2 void rows; 6 expected remain. |
| Cancel voids unpaid only | Pass | After amend+cancel: 0 expected; 2 paid rows identical to pre-cancel `id`/`paid_at`/`amount_cents`. |
| No bank transfer | Pass by design | Status change only. UI copy: “No bank transfer is initiated.” Snapshot/audit `noBankTransfer: true`. |

## Out of scope / remaining

- Conductor mount of `SchedulesPanel` on `/payments` and `index.ts` export.
- Register `milestone05-schedules.ts` in `db/schema.ts` if future generates should see it.
- No ACH, no `registerCommsJob`, no production migrate, Linear Done left for the conductor.
