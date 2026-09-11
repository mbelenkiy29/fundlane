# MCA agent navigation

## Start here

The active application is `nextjs-version/` (Next.js 16, React 19, TypeScript). `vite-version/` and the root `docs/` are the original template/reference, not the MCA implementation. Prefer `nextjs-version/README.md` and its package scripts over legacy template instructions in the root README.

Linear project: [MCA](https://linear.app/michael-belenkiy/project/mca-1e94b0617388), ID `b223a780-3987-440c-8e04-41516a97e69b`. Current team: Michael Belenkiy (`MIC`), ID `bfc9ec70-5c0f-4515-a13b-a8d2f3ef3f9a`. Historical documents can use `SEN-*` identifiers; resolve tickets through Linear before relying on an old identifier or status.

Read the assigned Linear issue's acceptance criteria and dependencies, then query the graph from the workspace root:

```bash
graphify query "workspace authentication database" --budget 1500
graphify query "underwriting funder criteria submissions" --budget 1500
graphify explain "requireWorkspaceAccess"
graphify path "requireWorkspaceAccess" "getDatabase"
```

Follow returned source paths and line references to verify actual behavior. The graph is a navigation index, not evidence that a feature is complete or tested. If a query misses something, use targeted source search. From a subdirectory, pass `--graph` with the path to the root `graphify-out/graph.json`.

## Source map

All paths below are relative to `nextjs-version/`.

| Area | Entry points |
| --- | --- |
| Pages and HTTP endpoints | `src/app/`, `src/app/api/` |
| MCA UI and shared components | `src/components/mca/`, `src/components/ui/`, `src/components/layouts/` |
| Authentication and workspace isolation | `src/lib/mca/auth.ts`, `sessions.ts`, `policy.ts`, `workspaces.ts`, `memberships.ts` |
| Database and schema | `src/lib/mca/db.ts`, `src/lib/mca/db/schema.ts`, `drizzle/` |
| Deals and pipeline | `src/lib/mca/deals/` |
| Intake, documents and imports | `src/lib/mca/intake/`, `documents/`, `imports/` |
| Underwriting and funder matching | `src/lib/mca/underwriting/`, `funders/`, `datamerch/` |
| Submissions and sender configuration | `src/lib/mca/submissions/`, `senders/` |
| Closing, offer messaging and SMS routing | `src/lib/mca/closing/`, `sms/`, `src/components/mca/closing/`, `src/components/mca/sms/` |
| Company SMS onboarding, provisioning and inbox | `src/lib/mca/sms/onboarding.ts`, `provisioning.ts`, `inbox.ts`, `src/lib/mca/db/sms-onboarding.ts`, `docs/sms/company-onboarding.md` |
| Render deployment | `../render.yaml`, `Dockerfile`, `docs/render-deployment.md` |
| Previous Railway deployment and verification | `Dockerfile`, `railway.json`, `scripts/railway/`, `docs/milestone-05/provider-activation.md` |
| Encryption, email and API keys | `src/lib/mca/crypto.ts`, `email.ts`, `api-keys.ts` |
| Tests | `tests/`, `src/lib/mca/deals/acceptance.test.ts` |
| Migration tooling | `scripts/neon/`, `drizzle.config.ts` |
| Plans, contracts and verification evidence | `docs/milestone-*/`, `docs/acceptance/`, `docs/neon-*.md` |

The app uses Neon Postgres. SQLite references concern historical state or migration tooling. Document bytes remain in filesystem storage. Read the active README before environment setup or database work. Local runtime data and environment files are excluded from Graphify.

## Graphify setup and refresh

Clerk owns browser authentication through `src/proxy.ts`, `src/lib/mca/clerk-auth.ts`, and the existing custom auth forms. Neon remains authoritative for MCA memberships, roles, and financial permissions. Team delivery is in `clerk-team.ts`; signed event reconciliation is in `clerk-webhooks.ts`. See `nextjs-version/docs/clerk-auth.md` and `scripts/clerk/migrate.ts` for the additive migration and separate production cutover. Legacy password/session HTTP issuance returns 410; API keys retain their existing gateway.

Following the [official Graphify README](https://github.com/Graphify-Labs/graphify), this workspace uses `graphifyy` (double y), version 0.9.18 with SQL support. It is a Python developer tool, not an application dependency.

On a fresh machine, from the workspace root:

```bash
uv tool install 'graphifyy[sql]==0.9.18'
graphify install --project --platform codex
graphify install --project --platform agents
graphify extract . --code-only --max-workers 4
graphify cluster-only . --no-label
```

If the command is missing from PATH, run `uv tool update-shell` and reopen the terminal. The project skills are in `.codex/skills/graphify/` and `.agents/skills/graphify/`; `AGENTS.md` carries the persistent query-first instructions. Codex's generated hook is a compatibility no-op; the instructions are what direct agents to the graph.

After code changes, from the workspace root:

```bash
graphify update .
graphify cluster-only . --no-label
```

Inspect any shrinking-graph warning before using `--force`; a reduced graph can indicate a wrong scan directory. After changing scan exclusions or parser dependencies, use `graphify extract . --code-only --max-workers 4 --force` and regenerate the report.

Outputs are `graphify-out/graph.json`, `GRAPH_REPORT.md`, and `graph.html`. The graph indexes active application code, tests, scripts, and SQL migrations. It deliberately excludes the Vite reference, root template docs, generated files, agent skills, and runtime data via `.graphifyignore`. The initial extraction is code-only: prose, PDFs, images, and Linear tickets are not semantically indexed. Read local implementation docs and live Linear requirements separately. A later full `$graphify` pass can add semantic relationships.

This local workspace had no `.git` at setup. After it becomes a Git checkout, run `graphify hook install` if post-commit/post-checkout refresh is desired. Until then agents refresh explicitly; no background watcher was started. Preserve this guide and the project skills when sharing the workspace. Keep generated graph/report/HTML artifacts with it, or rebuild them on the destination machine. Machine-local caches and interpreter pointers are ignored in `.gitignore`.

## Validate implementation changes

Use Node.js 24+ and pnpm. From `nextjs-version/`, the verification commands are `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Run checks appropriate to the changed behavior. Database tests require the protected Neon verification environment described in the active README; do not substitute application data for an isolated test database.

Refresh the graph after changes and update this guide when module ownership or entry points change. Fetch live Linear status before selecting work or recording completion; milestone snapshots and generated graphs can become stale.

Clerk company billing uses `nextjs-version/src/lib/mca/billing.ts`, `/api/billing`, and `workspace_billing` (migration 0019). Neon enforces active/pending seat reservations; company features remain accessible. See `nextjs-version/docs/clerk-billing.md` for the development catalog, least-privilege roles, and reconciliation commands.

Public Fundlane marketing lives at `/` and `/demo`, with components in `nextjs-version/src/components/marketing/` and the demo-delivery endpoint at `/api/marketing/demo`. See `nextjs-version/docs/marketing-site.md` for sales webhook/privacy activation, receiver deduplication requirements, synthetic product captures, and verification. Demo requests use the existing shared request-rate table; no lead data is written to MCA workspaces.
