# Milestone 05 lane B acceptance evidence

Verification uses synthetic records in a disposable database created by `tests/helpers/postgres-test-db.mjs`. It never migrates production or reads production rows.

## MIC-161 — exact offer calculations

- `src/lib/mca/accounting/money.ts` accepts decimal strings, converts them to integer ratios, and rounds only at the final cent boundary. Scientific notation and excess scale are rejected.
- `src/lib/mca/accounting/calculations.ts` snapshots rule version, inputs, rounding, overrides, fees, the explicitly principal-based commission, and any supplied-versus-estimated payment difference. A payment estimate remains unknown without frequency, count, and calendar convention. Factor rate is never presented as APR.
- Synthetic result: principal `4,000,000` cents × factor `1.25` = `5,000,000` cents payback; 800 basis points on principal = `320,000` cents commission.
- Evidence: `tests/milestone05-accounting-core.test.ts` covers the required result, decimal regression, runtime commission-base rejection, and missing-calendar behavior.

## MIC-107 — advance ledger and performance

- `src/lib/mca/advances/` reads immutable funded advances and joins business, funder, offer term, payment schedule, assigned team, and manual status history.
- Scheduled paid-in values are visibly labeled estimates. The convention is first payment after one full period; business-day daily schedules exclude weekends; monthly schedules use monthly anniversaries and clamp month-end. Values are capped at payback and 100%. Unknown calendars remain unknown, and future funding dates return zero.
- Manual on-track, missed-payment, default, renewed, and closed corrections require an administrator plus a user-entered reason and append status history. They do not create collection records.
- `AdvancesPanel` includes loading, empty, error and success states, deal details, term/frequency, estimate labeling, team, history, and permissioned corrections.
- Evidence: core boundary tests and the disposable database default test in `tests/milestone05-accounting-db.test.ts`.

## MIC-112 — commission and fee ledger

- `writeFundingAccounting` is a `FundingAccountingWriter` called with the funding flow's existing `DbExecutor`; it opens no nested transaction. One funding transaction therefore creates its base advance plus idempotent commission, fee, and split children or rolls all of them back.
- Automatic payment identity is unique by workspace, advance, type, and funding idempotency key. It snapshots the primary originator and uses distinct expected commission and expected fee dates.
- The ledger separates expected and collected cents and derives outstanding cents. Immutable adjustments change effective expected revenue and reconciliation status while preserving the original payment row. Filters cover date, originator, and status.
- Receipt, adjustment, split, and distribution mutations lock the parent advance before child rows, matching funding reversal's lock order. Mutations re-check and reject a reversed advance, closing the reversal-versus-receipt race without altering paid history.
- Payment table access requires the configured Payments feature/page and `viewPaymentTable`. Company totals are returned only with `viewCompanyFinancials`; a direct-API test proves an administrator denied by configured flags receives 403 and a table-only administrator receives no totals.
- UI supports an advance selector, stable retry identity after response loss, drilldown, receipt reconciliation, reasoned adjustments, and explicit no-transfer language.
- Evidence: funding writer replay, originator/date, reconciliation isolation, idempotent effective-total adjustments, and direct feature/page/action permission cases in `tests/milestone05-accounting-db.test.ts`.

## MIC-103 — versioned split rules and distributions

- Template edits append immutable numbered versions. Save and apply validate that all recipients are active members of the same workspace and allocations total exactly 10,000 basis points.
- Allocation uses largest fractional remainder then input order, with that rule and inputs persisted in every payment snapshot. A 33.33/33.33/33.34 split of $100.00 yields $33.33/$33.33/$33.34 exactly.
- A locked payment cannot receive a second active allocation under a different key. Paid distributions cannot be voided or have their original paid date rewritten; unpaid rows may be voided before a replacement. No action initiates a bank transfer.
- UI supports one or more recipient rows, saved versions, apply-to-payment, distribution history, actual paid date, mark-paid, and void actions.
- Evidence: exact unit case plus disposable database over-allocation, three-recipient, and paid-replay cases.

## MIC-105 — advance-specific renewals

- Versioned workspace policies use paid-in basis points and minimum funded age. Scheduler identities contain policy version and advance ID, so retries produce one action per qualifying advance.
- Two advances for the same merchant produce two independently linked actions. Previews use business/funder names and formatted dollar amounts. Filters support state and eligible-through date.
- The update flow saves editable previews, creates idempotent fresh-statement and voided-check stipulation tasks through Closing's typed service, and validates that a repeat-funding deal is accessible, in the same workspace, and distinct from the source deal.
- Linking a renewed deal updates lineage only; prior funding and commission rows are unchanged.
- UI exposes policy versioning, eligibility run, editable previews, fresh-document tasks, and repeat-deal linkage through a named selector populated by the user's permission-filtered deal list; the source deal is excluded.
- Evidence: two-advance scheduler retry and lineage/document-task cases in `tests/milestone05-accounting-db.test.ts`.

## MIC-111 — validation gate

Implementation is intentionally pending the ticket's required user validation. The proposed example sent for validation is four Monday installments of $1,000 beginning October 5, 2026, split 60/40; reruns create each expected installment once, amendments affect unpaid future installments only, and records are accounting schedules rather than transfers. No reverse-consolidation schema or assumed production behavior was added before that validation.

## Verification result

- `node --conditions=react-server --import tsx --test tests/milestone05-accounting-core.test.ts tests/milestone05-accounting-db.test.ts`: 15 passed, 0 failed.
- Scoped ESLint for all lane B libraries, APIs, components, and tests: passed.
- Full-workspace `pnpm typecheck`: passed.
- No provider-dependent bank transfer behavior exists. Renewal document tasks are local workflow records; their separate outbound delivery remains explicit.
