# Neon lane C verification

Verified: 2026-09-08

## Scope

Lane C converted the documents, imports, and intake runtime paths and their API/page callers to the asynchronous PostgreSQL executor. All database, authentication, audit, checkpoint, and caller operations in this scope are awaited. SQLite runtime DDL and SQLite-only SQL were removed. Import row-result checkpoints execute on the same transaction client as deal creation or update and abort the deal mutation when the lease is stale.

The intake claim paths use PostgreSQL row locks, conflict-safe inserts, and lease-token completion fencing. Readiness recomputation locks the intake row so overlapping attachment completions cannot leave stale readiness state.

## Focused verification

- Intake core: 12/12 passed on an isolated migrated PostgreSQL database, including overlapping attachment and receipt workers and stale-lease completion rejection.
- Documents core: 11/11 passed on isolated PostgreSQL.
- Imports core: 14/14 passed on isolated PostgreSQL, including encrypted staging, lease reclaim, stale-worker rollback, replay, archive, and Drive checkpoints.
- Underwriting completeness handoff: 8/8 passed on isolated PostgreSQL.
- Funder directory and criteria scan: 15/15 passed on isolated PostgreSQL.
- Repository-wide TypeScript check passed after the lane C and funder concurrency changes.
- Lane C and funder targeted ESLint checks passed without warnings.

## Concurrency review and fixes

The independent cross-review found races in funder scan decisions, statement analysis/corrections, and DataMerch checks. The responsible lanes fixed each path.

Funder criteria publication now locks and reloads the funder before calculating its criteria version. Scan accept, reject, and rollback lock the funder and scan in a consistent order, revalidate state, and use expected-state predicates. Criteria replacement, the scan decision, and their audit records share one transaction. Rollback is rejected when a newer accepted scan remains active. Funder and group patch operations lock and reload records before merging partial updates.

Real PostgreSQL contention tests verify that simultaneous accept and reject operations commit exactly one consistent decision, and that concurrent disjoint funder and group patches preserve both changes.

The statement-analysis follow-up review confirmed that analysis now locks per deal, reloads inputs after acquiring the lock, preserves stable row identities, and derives the next aggregate version from locked state. Corrections lock the deal and target row, reload current metrics before applying a patch, and recompute the aggregate in the same transaction. Targeted PostgreSQL tests cover concurrent analysis and disjoint corrections.

The DataMerch follow-up suite passed 10/10, including its new contention cases. No remaining missed awaits, transaction-client escapes, SQLite runtime constructs, or SQLite-only SQL were found in the reviewed runtime paths.

The coordinating lane owns the final complete test suite, production build, and cutover decision.
