# Fundlane: one task, one isolated workspace

This guide is for a developer or coding agent working on a GitHub issue or Linear MCA ticket. Start with [the repo map](../../WORKSPACE_NAVIGATION.md), [agent instructions](../../AGENTS.md), and the [app setup](../README.md). The active app is `nextjs-version/`; root `docs/` and `vite-version/` are template references.

## The boundary

A cloud coding session, local worktree, or VM isolates **files and processes**. It does not create an isolated Supabase project by itself. Select a separate database/Auth/Storage environment explicitly.

| Need | Default for a task | When to use something else |
| --- | --- | --- |
| Code checkout | Fresh Codex or Claude cloud environment, or a local Git worktree on a feature branch | Use a personal VM if cloud sessions lack the required tools |
| Database unit/integration tests | Disposable PostgreSQL cluster with `CREATE DATABASE`; tests create and drop their own databases | Use a dedicated remote disposable PostgreSQL server when Docker is unavailable |
| Real Auth, Storage, OAuth or browser checks | A dedicated **nonproduction** Supabase project and Vercel preview with synthetic records | Per-PR Supabase branches only after verifying the repo's Drizzle migrations, runtime grants and project configuration there |
| Production | No agent access or automatic schema changes | Reviewed release procedure after PR approval |

Never put production `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `SUPABASE_SECRET_KEY`, encryption keys, Stripe keys, real customer records, or provider send credentials in an agent environment. Use credentials from the selected nonproduction environment, stored in that platform's secret store, never in Slack, commits, or logs. A test database admin URL must target a disposable cluster, **not** the application or production database.

## Start a task

1. Read the current Linear issue (acceptance criteria and dependencies) or GitHub issue and link it in the PR. If requirements are missing, identify them in the task thread before writing code.
2. Create a fresh coding session for `mbelenkiy29/fundlane` and a feature branch from current `main`; make one PR per task. In Slack, name the repository and task explicitly so the agent selects the right environment. A cloud session is already a per-task VM; no additional long-lived VM is required.
3. Follow `AGENTS.md`: consult `graphify-out/graph.json` with `graphify query` when present, then read the source and current docs. If the graph/tool is unavailable in a new VM, use targeted source search and state that limitation in the PR.
4. From `nextjs-version/`, use Node.js 24 and pnpm 11.1.2: `corepack enable`, `pnpm install --frozen-lockfile`. Configure only the environment needed for the task. For local app/Auth/Storage testing, start with `.env.example` and supply **nonproduction** Supabase project values in an ignored `.env.local`.
5. Work in the existing `src/`, `drizzle/`, `scripts/`, and `tests/` paths. Run the relevant tests, `pnpm typecheck`, `pnpm lint`, and `pnpm build` as appropriate; distinguish existing failures from newly introduced failures. Refresh Graphify after code changes when installed.
6. Open a PR with the issue link, change summary, migration impact, exact checks and results, any skipped hosted checks, and the preview link if one exists. Request human review. Do not merge or deploy as part of a coding task.

**Slack prompt example**

> @Codex Work on [issue URL] in `mbelenkiy29/fundlane`. Read `AGENTS.md` and `nextjs-version/docs/agent-task-workflow.md`. Make a branch, use only disposable test Postgres or approved staging Supabase, implement the acceptance criteria, run relevant checks, and open a PR. Do not connect to production or apply hosted migrations.

The same request can be sent to @Claude after its GitHub and cloud environment are connected.

## Disposable PostgreSQL for tests

The app's `pnpm test` expects `MCA_TEST_DATABASE_ADMIN_URL` pointing to a cluster where its test user can create databases. The test harness makes uniquely named test databases, applies checked migrations, and drops them. It does not need production data or a full Supabase VM. For a local machine or VM with Docker and an unused port:

```sh
docker run --rm --name fundlane-task-postgres \
  -e POSTGRES_PASSWORD=local_disposable_only \
  -p 127.0.0.1:55432:5432 postgres:16
```

In another terminal, from `nextjs-version/`:

```sh
export MCA_TEST_DATABASE_ADMIN_URL='postgresql://postgres:local_disposable_only@127.0.0.1:55432/postgres'
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Stop the container with `docker stop fundlane-task-postgres` when finished. The password above is only for this disposable loopback container. If Docker is unavailable in a hosted agent, supply a **separate disposable** remote PostgreSQL cluster through a secret store and set `MCA_TEST_DATABASE_DISPOSABLE=true` as required by the test harness; the user must still have `CREATE DATABASE`. Never point this variable at a production or shared staging application database.

For app/browser tests, use a separate Supabase project with its own Auth identities, buckets, encryption key and synthetic data. Match `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY` to that **one** project. Use its restricted `mca_app` role for runtime and an owner connection only in a controlled migration step. The app's [Supabase Auth guide](supabase-auth.md) covers callbacks, private session view and real hosted checks. Do not enable real email/SMS, live Stripe or external lender delivery in ordinary agent environments.

## Schema and migration ownership

Fundlane **already uses Drizzle**, not Prisma:

- `src/lib/mca/db/schema.ts` and related files listed in `drizzle.config.ts` describe tables for tooling.
- `drizzle/` contains the versioned SQL migrations and journal. `pnpm db:generate` generates a candidate migration; inspect and edit it for grants, indexes, RLS, data changes and existing table compatibility.
- `src/lib/mca/db.ts` uses `pg` through `DbExecutor` and transaction helpers. Much application SQL is hand-written, so a schema model alone does not describe authorization or business behavior.
- `src/lib/mca/supabase-auth.ts`, `src/lib/supabase/` and `src/proxy.ts` handle Supabase identity. Application memberships and permissions are enforced in server code and database grants. Supabase Storage manages private files.
- `scripts/database/migrate.ts` applies the checked Drizzle migration folder. `scripts/database/connections.ts` requires an exact `--expected-project-ref=REF` for hosted mutation; `pnpm db:secure` configures restricted runtime grants. These are **controlled release operations**, never VM bootstrap commands or PR build hooks.

Before changing a table, trace the relevant route/service, tenant/workspace filter, permissions, migrations, tests, and worker consumers. Commit the schema and matching forward migration together. Do not run Prisma `db push`, `migrate dev`, Supabase `db reset`, or a schema push against a hosted Fundlane project. Adding Prisma for discovery would introduce a second schema/migration authority; use the existing Drizzle schema, SQL migrations, `WORKSPACE_NAVIGATION.md`, and Graphify instead.

## Cloud and preview configuration

For Codex, create a cloud environment linked to the Fundlane GitHub repository with Node 24, pnpm and a setup step that installs dependencies. For Claude Code, authenticate the same repository in its cloud environment. The partner uses **their own** GitHub and agent account. Install the agent's Slack app in the relevant channel and ask it to open a PR; Slack is the request and status surface, while the session/PR holds diffs and test evidence.

An ordinary Vercel preview may safely use one dedicated staging Supabase project with synthetic data. Keep its Auth redirect allowlist and `MCA_APP_ORIGIN` aligned with the exact preview origin; arbitrary preview URLs can require additional callback configuration. A Vercel preview must not inherit production database or provider credentials.

Supabase preview branches offer a separate database, Auth endpoint and Storage per PR, without production rows by default. **Do not turn on automatic production deployment or assume this repo works with Supabase's `supabase/migrations` convention**: Fundlane's checked migrations live in `nextjs-version/drizzle/` and its security step is separate. First reproduce an empty branch from the complete migration history, verify the restricted role/private Auth view/buckets and synthetic smoke tests, and explicitly design how PR branches obtain and apply those migrations. Until then, dedicated staging plus disposable Postgres is the simpler, known path.

## Completion checklist

- [ ] Linked task and acceptance criteria addressed
- [ ] No production secrets/data, external sends, or hosted mutation in agent session
- [ ] Schema, migration, tenant isolation and permission impact explained
- [ ] Relevant tests and typecheck run; lint/build results or limitations recorded
- [ ] Hosted Auth/Storage/browser verification listed when required, not claimed from mocks
- [ ] PR opened for human review; deployment and provider activation tracked separately

Useful references: [Codex in Slack](https://developers.openai.com/codex/integrations/slack), [Claude Code in Slack](https://code.claude.com/docs/en/slack), [Supabase branching](https://supabase.com/docs/guides/deployment/branching), [Fundlane app README](../README.md).
