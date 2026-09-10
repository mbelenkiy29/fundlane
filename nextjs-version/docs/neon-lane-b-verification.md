# Neon migration lane B verification

Date: 2026-09-08

Lane B migrated the deals, funders, underwriting, Data Merch, and matching API/test surfaces from the former synchronous SQLite access pattern to the shared asynchronous PostgreSQL facade in `src/lib/mca/db.ts`. Database calls are awaited, PostgreSQL syntax is used, repository runtime DDL was removed, and mutation paths preserve workspace scoping, idempotency, version checks, audit writes, and transaction boundaries.

## Source protection

The pre-code source/config snapshot was created before migration writes:

- File: `data/mca-source-pre-neon-20260908T164631Z.tar.gz`
- Mode: `0600`
- SHA-256: `e75dded7d4bd79ae9688f228d360d2a224d985e4e6fcedd1d940fe36778e5710`
- Secrets and heavy/runtime artifacts were excluded.

Additional snapshots preserved late Milestone 3 work before its PostgreSQL port:

- `data/mca-m3-lane-b-pre-neon-20260908T131700EDT.tar.gz` — SHA-256 `668d782c5e5d183fa5a8f228a7d8d9a6eaa4a7386f0f2ab87699535805c6472e`
- `data/mca-m3-analysis-pre-neon-20260908T133000EDT.tar.gz` — SHA-256 `e1505a6f75e0fd987b373f71f721501d9678aac6558395d236fc8c06c1458cc8`
- `data/mca-m3-review-post-neon-20260908T135600EDT.tar.gz` — SHA-256 `e221d708eaba44c278050b810796115546a42667c2dcc0a301715c8742e1c2df`

## Transaction and concurrency guarantees

- Deal creation and updates retain idempotency and version compare-and-swap behavior. The async deal mutation checkpoint runs on the same transaction/client as the persisted deal mutation, allowing ingestion state to commit or roll back atomically.
- Statement analysis performs provider I/O before entering the database transaction. It then locks the deal row, reloads statement months, positions, and the aggregate, recomputes from the locked state, persists the result, and records the audit event in one transaction. Concurrent analysis of the same input returns the same aggregate version and semantic position identity.
- Statement month and position corrections lock the deal first and then the target row with `FOR UPDATE`. Each correction patches the freshly reloaded row, recomputes the aggregate, marks dependent analysis snapshots stale, and writes its audit event in the same transaction. Disjoint concurrent corrections are both retained.
- Funder criteria decisions lock the funder and scan in a consistent order, revalidate state, and use status/rollback compare-and-swap predicates. Criteria publication or rollback, scan state, and audit writes share one transaction. Funder and group edits reload under row locks before merging a partial patch.
- Data Merch checks use an atomic lease claim. Only the lease owner calls the provider; completion is fenced by the lease token, clears the lease, and commits the diagnostic and audit with the result. Expired claims can be recovered while stale completions are rejected.

## Focused verification

Every database-backed test below used `tests/helpers/postgres-test-db.mjs`, which creates a unique database on the configured Neon verification branch, applies Drizzle migrations, and drops the database during cleanup. No production or Fundlane application database was used.

- `tests/funders-directory.test.ts`: 6/6 passed
- `tests/funders-criteria.test.ts`: 8/8 passed
- `tests/funders-scan.test.ts`: 7/7 passed before the added decision race case; the final global run owns the updated count
- `tests/underwriting-scoring.test.ts`: 6/6 passed
- `tests/underwriting-analysis.test.ts`: 6/6 passed
- `tests/datamerch.test.ts`: 8/8 passed before the added lease race cases; the final global run owns the updated count
- `tests/underwriting-completeness.test.ts`: 8/8 passed
- `tests/underwriting-review.test.ts`: 6/6 passed
- `tests/deals-http.test.mjs`: 1/1 passed, including isolated Next.js HTTP execution and cleanup
- `tests/underwriting-statements.test.ts` plus `tests/underwriting-corrections.test.ts`: 16/16 passed in 37.2 seconds after the concurrency fixes

The statement race test overlaps two provider calls and asserts both callers observe aggregate version 1, the same position ID, and one matching semantic position in PostgreSQL. The correction race test runs disjoint deposit and NSF corrections in parallel and confirms both values survive with the correct stale aggregate.

`tsc --noEmit --pretty false` passed after the final lane B changes. Focused ESLint over the statement repository, statement service, correction service, and their two test files passed with no findings. The full-suite, production-build, and cutover verification are owned by the integration coordinator after all lanes merge.
