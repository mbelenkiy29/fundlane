# Fundlane database and Drizzle

Fundlane is already past the installation and introspection steps in Drizzle's [existing Supabase project guide](https://orm.drizzle.team/docs/get-started/supabase-existing). `drizzle-orm`, `drizzle-kit`, `pg`, and `tsx` are installed. Do not pull a replacement baseline into `drizzle/` or connect a schema tool to production to discover this app.

## Sources of truth

- `drizzle.config.ts` lists the application schema files. `src/lib/mca/db/schema.ts` contains the original broad table model; the other listed files contain later, maintained feature tables. The broad file uses introspection-style definitions and has been edited in subsequent commits. Treat all listed TypeScript files as maintained schema source, not disposable generated output. `drizzle/meta/` snapshots and the journal are generated migration history; keep them with their checked SQL.
- `drizzle/*.sql` and `drizzle/meta/_journal.json` are the versioned, applied application migrations. `scripts/database/migrate.ts` uses `drizzle-orm/node-postgres` to apply them through `DATABASE_URL_UNPOOLED`. `scripts/database/connections.ts` requires an explicitly disposable local target or a matching hosted project reference. `scripts/database/secure-runtime.ts` separately configures the restricted `mca_app` role, application-table grants and RLS, and private access to selected provider data.
- `src/lib/mca/db.ts` owns the runtime `pg` pool, query executor, transaction context, and worker execution checks. Most application queries are explicit SQL. The TypeScript schema does not enforce workspace authorization: routes obtain an actor through `requireWorkspaceAccess`, services pass its workspace ID, and repositories filter by `workspace_id`. The server role's RLS policy permits application-table access; server code is responsible for tenant checks.
- Supabase Auth (`src/lib/mca/supabase-auth.ts`, `src/lib/supabase/`, `src/proxy.ts`) and private Supabase Storage have separate integration paths. The `auth`, `storage`, and `stripe` schemas are provider-owned, not application migration inputs.

## Bounded schema audit for issue #33

The disposable PostgreSQL harness in `tests/helpers/postgres-test-db.mjs` creates a fresh database, applies the complete checked migration journal, and drops it. Run `MCA_TEST_DATABASE_ADMIN_URL=<disposable local admin URL> node --conditions=react-server --import tsx --test tests/drizzle-schema-audit.test.ts` from `nextjs-version/`. The test compares Drizzle definitions with the migrated catalog for `workspaces`, `mca_funders`, and `mca_funder_groups`: column names/types/nullability/defaults, primary and named constraints, and index names and access methods. It passed against PostgreSQL 14.23 in a temporary local cluster on 2026-09-23. No mismatch in that bounded set required a schema or migration correction. This does not claim full schema coverage or validate hosted Supabase grants.

## Typed-query pilot decision

`listFunderRecords` was evaluated and left on the existing executor. It serves the funder API and is also called by intake, underwriting, submission, and messaging services. Its `getDatabase()` lookup inherits the current transaction's connection; the executor also checks worker execution state and serializes commands inside transactions. Connecting Drizzle directly to the shared `pg` pool would lose uncommitted-read visibility and bypass those execution checks. The funder test now records the transaction-visibility requirement. A safe pilot needs a small, reviewed Drizzle adapter bound to the current `DbExecutor` (including its transaction serialization and worker fence) before replacing this read. That adapter is broader than the one-query change authorized for this issue.

## Changing an application table

Trace the route, authorization, repository SQL, workers, and tests first. Edit the maintained Drizzle schema, generate a candidate forward migration with `pnpm db:generate`, inspect and adjust its SQL, then test the complete checked history on disposable Postgres. Include any required grants or data changes in the reviewed release procedure. Apply `db:migrate` and `db:secure` only to an explicitly selected release target; they are not build steps.
