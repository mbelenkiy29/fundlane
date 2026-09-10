# Fundlane: SQLite to Neon Postgres migration plan

Planning only, 2026-09-08. Execution and verification must use GPT-5.6 Sol with high reasoning; this plan is the Astra planning deliverable. No application or database implementation was performed by the planning agent.

Coordinator provisioning update: Fundlane exists as `cool-pine-95841889`; intended app branch is `br-aged-sun-aeqj80uv`, isolated migration-verification branch is `br-gentle-sound-aencsy8p`, database `fundlane`. Protected connection material is in `.neon/migration-connections.json` under production/verification keys. Do not recreate these resources. Add `.neon/` to ignore rules before other changes and never print its contents. The coordinator has read current Neon connection/pooling docs via text fetch; backups are assigned separately. Environment cutover has not occurred.

## Outcome and boundaries

Create the requested Neon project **Fundlane**, preserve the existing application records and credentials, and switch the Next.js application to asynchronous Postgres access. Keep the existing authentication and document storage architecture. Finish with the application server stopped. This workspace has no Git repository, so make a timestamped filesystem backup before editing; do not assume Git can restore changes.

## Evidence and scope

- `src/lib/mca/db.ts` opens a process-global `node:sqlite` `DatabaseSync`, initializes schema on demand, and wraps synchronous callbacks in `BEGIN IMMEDIATE`. Repository calls, audit writes, and most authentication functions return values synchronously.
- There are **50 CREATE TABLE declarations** across the foundation and feature repositories. The source includes lazy ALTER TABLE migrations for document lineage and confirmation leases, import commit leases/review metadata, intake leases, and underwriting corrections. Inventory the live SQLite schema too; never infer that its tables exactly match these declarations.
- Foundation: `db.ts`, `auth.ts`, `sessions.ts`, `api-keys.ts`, `memberships.ts`, `workspaces.ts`; direct SQL also exists in `src/app/api/audit/route.ts`.
- Feature repositories: deals; documents; imports; intake; DataMerch; funder directory and criteria; underwriting statement and completeness repositories. Their services and callers must become async as one coherent change.
- Route families cover authentication, memberships, invitations, workspace, audit, API keys, and every `api/mca` feature. Server-rendered dashboard/settings/auth pages and `app/apply/[formId]/page.tsx` need an await audit as well. Search imports transitively, including access-policy functions and helpers that previously accepted synchronous callbacks.
- Tests include eleven feature/foundation TypeScript suites, the deals acceptance suite, and four HTTP suites. Many fixtures use SQLite directly; HTTP suites spawn Next and pass `MCA_DB_PATH`. These tests must exercise Postgres instead of silently retaining a SQLite test backend.
- `crypto.ts` binds AES-GCM ciphertext to workspace IDs. `MCA_DATA_ENCRYPTION_KEY` must stay unchanged. Development has a stable fallback key: identify whether it was actually used before choosing any destination key. Existing hashes, ciphertext, IDs, token hashes, and storage keys must be copied verbatim.
- Documents live separately under `MCA_DOCUMENT_STORAGE_PATH` or `data/documents`. Moving metadata does not move or replace those files.
- `underwriting/statement-repository.ts:markAnalysisSnapshotsStale` dynamically probes optional snapshot tables using `sqlite_master` and PRAGMA; this is a runtime query, not merely an obsolete schema initializer.

## Target architecture and shared contract

Use `pg` with a bounded, reusable Node.js Pool and Drizzle for the typed Postgres schema and checked-in versioned migrations. The application remains on the Node runtime. Use `DATABASE_URL` (pooled) for the application and `DATABASE_URL_UNPOOLED` (direct) for migrations and data transfer. Preserve TLS verification. Do not use a synchronous network shim, child process per query, an in-memory SQLite mirror, or dual-write fallback.

Publish the shared API before parallel edits:

```ts
type DbExecutor = { query<Row>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number }> }
async function query<Row>(sql: string, values?: unknown[]): Promise<Row[]>
async function queryOne<Row>(sql: string, values?: unknown[]): Promise<Row | undefined>
async function execute(sql: string, values?: unknown[]): Promise<number>
async function withTransaction<T>(work: (tx: DbExecutor) => Promise<T>): Promise<T>
async function closeDatabaseForTests(): Promise<void>
```

The exact generic constraint can follow pg types. Normalize pg's nullable rowCount in one place. Migrations are an explicit CLI step, never DDL during requests. Drizzle owns schema/migration generation; carefully reviewed parameterized SQL through pg is acceptable for existing complex repositories. Replace `?` with `$1...$n` in each statement, including generated filters; do not perform a blind global substitution over SQL literals.

Practical compatibility option: an **asynchronous** `prepare(sql).get/all/run` adapter is acceptable to reduce surface churn, if every execution returns a Promise, get/all/run normalize pg results, and placeholder translation correctly tokenizes quoted strings, quoted identifiers, dollar-quoted literals, SQL comments and real placeholders. It must not attempt generic SQLite dialect translation: owners still explicitly port NOCASE, introspection, INSERT OR, nullable IS comparisons and concurrency logic. Publish one chosen API, not competing adapters, before lanes begin. No synchronous caller compatibility is possible or permitted.

Every statement in a transaction must use the same checked-out client. Acquire, BEGIN, await the callback, COMMIT or ROLLBACK, and release in finally. Pass the transaction executor into called repository functions (including hydration and checkpoint callbacks); do not let them escape to the pool. If nesting is required, pass the existing executor rather than issuing another BEGIN. An AsyncLocalStorage alternative is possible but explicit transaction parameters are easier to review here. Keep remote email, Drive, parsing, and object/file work outside database transactions; retain their existing reservation/checkpoint workflows.

Every function that actually touches the DB returns a Promise. Propagate await through services, auth, audit, routes and server components. Convert transaction callback signatures to Promise-returning callbacks and await them. Replace async `forEach` with awaited loops where ordering matters. Fix return-type compositions using `Awaited<ReturnType<...>>` so public result types are not accidentally nested Promises. Pure parsing, policy checks, IDs, encryption and validation remain synchronous when their inputs are already loaded.

## Schema and SQL conversion

1. Model all current tables, keys, constraints, defaults and indexes, including lazy-added columns and backfills, in one initial Postgres migration. Preserve TEXT IDs, ISO timestamp strings, JSON text and integer flags initially to minimize behavioral changes and permit byte-exact data comparison. Keep encrypted JSON columns as text. Preserve numeric precision appropriate to current values; inspect SQLite REAL uses before choosing double precision versus numeric and normalize pg return values deliberately.
2. Replace SQLite NOCASE with explicit case-insensitive comparisons/indexes. A unique index on `lower(email)` plus matching lookup normalization is appropriate for users; aliases need `(workspace_id, lower(alias))`. Preserve existing display casing and test collisions. SQLite NOCASE is ASCII-oriented, so document/test any Unicode behavior difference rather than claiming exact equivalence.
3. Translate `INSERT OR IGNORE` to targeted `ON CONFLICT ... DO NOTHING`, `.changes` to rowCount, `attempt_token IS ?` to `IS NOT DISTINCT FROM $n`, and introspection to information_schema or an explicit known-table list. Audit SQLite-only expressions and ambiguous Postgres UPSERT references such as `request_count = request_count + 1`; qualify the target table.
4. Type ambiguous parameters used only with `IS NULL` where Postgres cannot infer a type. Keep all values parameterized; dynamic table/column identifiers require an allowlist.
5. Postgres transactions are not SQLite's single-writer critical sections. Protect every read-check-write invariant with a row lock, unique constraint/UPSERT, or a conditional UPDATE. Catching a uniqueness exception inside a transaction does not restore that transaction; prefer ON CONFLICT or a savepoint.

## Atomicity and concurrency acceptance requirements

- **Deals:** preserve version-conditional UPDATE, children replacement, activity insertion and import checkpoint in one transaction. Zero updated rows must return the existing conflict behavior. Concurrent create retries with the same workspace/idempotency key must return one logical deal without duplicate children. Review display-ID allocation for races.
- **Import commit:** claim/reclaim with one conditional UPDATE RETURNING (state, revision, current token and expiry predicates), or lock the run row before checking. In `recordRowResultInTransaction`, lock/validate the import run token within the same transaction as the deal write and checkpoint; otherwise another worker can reclaim after a token read. Lease renewal and completion must condition on the token and workspace. A stale worker must roll back its deal mutation. Retain preview revision compare-and-swap and replay checkpoints.
- **Intake:** reserve events with unique `(workspace_id, provider, provider_event_id)` conflict handling. Attachment/receipt claim routines currently read eligibility and then update under BEGIN IMMEDIATE; convert to locked reads or eligibility-conditional UPDATE RETURNING. Completion requires the exact lease token. Retain due-time, expiry, attempt-count and workspace conditions. Concurrent reservation and enqueue retries must resolve to the same rows.
- **Documents:** reserve idempotency key/lineage versions safely, lock the lineage or equivalent parent during allocation. Confirmation source and confirmation ID unique keys both matter. Reclaim must compare the old nullable token, and complete/fail must require the current attempt token. Preserve failed/retry states and stale-worker rejection.
- **Foundation:** use atomic rate counter UPSERT RETURNING, enforce seat limit and last-admin invariants under a workspace row lock, consume invitation/recovery/OAuth state once, and prevent bootstrap races. Session invalidation and membership lifecycle writes must remain atomic.
- **Other features:** retain funder criteria replacement transactions and aggregate/correction consistency. Await audit writes; where the existing code had audit outside a mutation transaction, do not silently lose the audit on a floating Promise. Prefer an optional executor to include it in the relevant transaction when appropriate.

## Data preservation and cutover

1. Inventory authenticated Neon organization/project context without printing secrets. Create Fundlane in the appropriate available organization/nearby region. Record only project/branch IDs in the handoff. If authentication is unavailable, report that concrete blocker; do not silently create an expiring claimable database.
2. Stop this application's Next server and workers before the authoritative snapshot. Record PIDs/ports, target only the relevant processes, and keep the app stopped during migration. Do not kill unrelated Node processes. No migration agent should start a persistent dev server.
3. Make a timestamped copy of application source/config and document files with restrictive permissions. For SQLite use the backup API or VACUUM INTO against the quiesced DB (WAL-safe), not a lone copy of `mca.sqlite` while WAL exists. Keep the original SQLite/WAL/SHM and config intact. Check SQLite integrity and foreign keys; record table/column inventory and counts, without printing rows or secrets.
4. Save the active encryption-key provenance and other existing secrets securely; never rotate them as part of database setup. If ciphertext used the local fallback, retain the identical effective key for migration and separately arrange any future rotation. Validate decryption using the existing key without logging plaintext. Preserve auth token hashes and document storage paths.
5. Create a migration-validation branch in Fundlane. Apply checked-in migrations there using the direct URL. Build a standalone importer whose only SQLite usage is reading the snapshot read-only. Derive explicit source-to-target table/column mapping from the inventory; fail on unexpected populated tables/columns instead of dropping them silently.
6. Import in foreign-key order. Resolve membership self-references by inserting manager IDs null then restoring them, or use deliberately deferrable constraints. Preserve nulls and values exactly. Use one transaction for this small local database, with a destination-empty guard and a migration ledger/checksum; if too large, stage data then commit promotion atomically. Do not use conflict-ignore to hide differing destination records.
7. Validate per-table counts, sorted primary-key sets, and canonical row digests, with deliberate normalization only for chosen numeric types. Verify FK constraints, encrypted-value digests and sampled decryptability, record relationships, document checksums/storage keys, and existing authentication hashes. Include all 50 declared tables plus any additional live populated schema.
8. Run the full migrated tests on an isolated test branch/database, and migration rehearsal on the validation branch. Only then apply the schema/import to Fundlane's intended app branch from the same immutable snapshot. Repeat parity checks.
9. Update only database variables in the existing env file via structured code, preserving every other key and permissions; never print URLs/passwords. Set pooled/direct URLs separately. Disable SQLite runtime fallback and fail clearly when DATABASE_URL is missing. Do not bootstrap replacement demo records into the migrated DB.
10. Smoke-test the migrated app briefly with existing users/records and safe local provider stubs, then stop it and verify its port/process is gone. Leave backups and a redacted migration report. Before new live writes, rollback is restoring the prior source/config and SQLite snapshot; after new writes, rollback requires reconciling/exporting them first, not blindly reverting.

## Parallel execution ownership (maximum three Sol high agents)

Have the foundation owner publish the API/schema contract first. Then assign disjoint files; the coordinator resolves shared boundaries once. No agent edits another owner's files without handoff.

| Owner | Files and responsibility |
| --- | --- |
| A — foundation and integration | `db.ts`, Drizzle schema/config/migrations, package manifests, env/docs, importer/parity scripts, foundation auth/session/API keys/memberships/workspaces; foundation routes/pages and foundation tests; provisions Neon and controls cutover. Owns shared test database helper. |
| B — deals and analysis | `deals/*`, `funders/*`, `underwriting/*`, `datamerch/*`, matching API routes and tests including deals acceptance and HTTP; awaits shared auth calls in its routes. Owns deal transaction/checkpoint API and coordinates that signature with C. |
| C — document and ingestion workflows | `documents/*`, `imports/*`, `intake/*`, matching routes and tests; owns lease/idempotency conversion and relevant HTTP suites; awaits shared auth calls in its routes. |

After implementation, a Sol high verifier reviews cross-owner awaits/transactions, runs checks, repairs bounded integration issues through the file owner, and audits preservation evidence. Provisioning/data migration must have one owner. Do not run agents that each independently change env, schema, dependencies, or production data.

## Verification and completion gate

- Share a Postgres test fixture that uses an explicitly isolated branch/database (or uniquely named schema with validated identifier and connection-level search path compatible with every pooled connection). Migrate it first; never allow tests to truncate app data. HTTP child processes receive the same isolated connection context. Await fixture setup, teardown and pool closure.
- Convert all direct SQLite test fixtures and `MCA_DB_PATH` assumptions. Cross-tenant tests currently toggle `PRAGMA foreign_keys`; construct valid tenant-mismatched fixtures instead, or use a narrowly isolated explicit strategy. Do not disable Postgres constraints globally.
- Run TypeScript, lint, full node:test suite, production build. `npm test` already serializes files but race tests must use multiple real pooled connections and synchronization barriers. Do not replace DB integration tests with mocks merely to make them pass.
- Add focused race tests: duplicate deal/idempotent reservation; two workers claim one import/intake/document job; expired lease reclaim and old-token completion rejection; stale import token rolls back deal/children/activity/checkpoint; concurrent version updates produce one winner; rate counters and seat cap retain their limits.
- Add transaction failure injection: throw after a write and checkpoint then confirm no partial data; prove reads inside the transaction see its own writes through the same executor.
- Add import preservation test with encrypted fields and linked rows, digest equality, retry/no-op behavior only when snapshot digest matches, and destination mismatch refusal. Test source with outstanding WAL through a safe snapshot.
- Check migrated existing-user session/login behavior and key decryptability without secret output; test a document metadata/download path against preserved storage using a safe authenticated test.
- Final source scan: no `node:sqlite`, PRAGMA, sqlite_master, synchronous DB methods, or schema initialization in runtime `src`; SQLite is permitted only in the offline import utility. Inspect Promise use in routes and callbacks, not only typecheck.
- Ensure all test child servers and pools terminate even on failure. Final report includes project/branch identifiers, tables/rows migrated, checks run/results, backup/report paths and confirmation that the application server is stopped. It excludes connection URLs and secrets.

References: [Neon pooling](https://neon.com/docs/connect/connection-pooling), [Neon Drizzle guide](https://neon.com/docs/guides/drizzle), [node-postgres transactions](https://node-postgres.com/features/transactions). The installed Neon parent and Postgres skills were read; node-postgres documentation confirms that a transaction must use one client instance. Neon web fetch returned an unsupported markdown content-type, so provisioning should re-check current CLI/docs through an available text-fetch mechanism.
