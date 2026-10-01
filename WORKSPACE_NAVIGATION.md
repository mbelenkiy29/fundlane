# MCA agent navigation

## Start here

The active application is `nextjs-version/` (Next.js 16, React 19, TypeScript) hosted on Vercel. Supabase owns Postgres, Auth, and private Storage. Render is historical only; worker ownership and acceptance are mapped in `nextjs-version/docs/background-job-runtime.md`. `vite-version/` and the root `docs/` are the original template/reference, not the MCA implementation. Prefer `nextjs-version/README.md` and its package scripts over legacy template instructions in the root README. Clerk and Neon are not part of the runtime.

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
| New-workspace setup checklist | `src/lib/mca/setup/`, `src/components/mca/setup/`, `src/app/api/mca/setup/` |
| MCA UI and shared components | `src/components/mca/`, `src/components/ui/`, `src/components/layouts/` |
| Read-only ChatKit panel and `/assistant` tab | `src/lib/mca/assistant/chatkit-context.ts`, `chatkit-ui.ts`, `gateway.ts`, `security.ts`, `store.ts`, `tools.ts`, `src/components/mca/assistant/chatkit-session.tsx`, `assistant-workspace.tsx`, `src/app/api/mca/chatkit/`, `../chatkit-service/`, `docs/chatkit-assistant.md` |
| Authentication and workspace isolation | `src/lib/mca/auth.ts`, `supabase-auth.ts`, `src/lib/supabase/`, `src/proxy.ts`, `policy.ts`, `workspaces.ts`, `memberships.ts`, `docs/supabase-auth.md` |
| Database and schema | `src/lib/mca/db.ts`, `src/lib/mca/db/schema.ts`, `drizzle/` |
| Company billing | `src/lib/mca/billing.ts`, `/api/billing`, `/api/webhooks/stripe`, `docs/supabase-billing.md` |
| Deals and pipeline | `src/lib/mca/deals/` |
| Sidebar/deal AI assistant, credits and admin alerts | `src/lib/mca/assistant/`, `src/components/mca/assistant/`, `src/app/api/mca/assistant/`, `docs/deal-assistant.md` |
| Intake, application review, documents and imports | `src/lib/mca/intake/` (`review.ts`, `notifications.ts`, `submission-review.ts`), `src/components/mca/intake/application-review.tsx`, `documents/`, `imports/`, `docs/application-intake.md` |
| Underwriting and funder matching | `src/lib/mca/underwriting/`, `funders/`, `datamerch/` |
| Submissions and sender configuration | `src/lib/mca/submissions/`, `senders/` |
| In-app email conversations and worker | `src/lib/mca/email-conversations/`, `src/components/mca/email/`, `src/app/api/mca/email/`, `scripts/messaging/`, `docs/email-conversations.md` |
| Outbound workflow webhooks and daily report email | `src/lib/mca/comms/webhooks.ts`, `workflow-events.ts`, `digest.ts`, `scheduler.ts`, `src/components/mca/comms/webhook-console.tsx`, `digest-settings.tsx`, `/api/mca/comms/`, `/api/cron/comms`, `docs/outbound-webhooks-and-daily-reports.md` |
| Closing, offer messaging and SMS routing | `src/lib/mca/closing/`, `sms/`, `src/components/mca/closing/`, `src/components/mca/sms/` |
| Company SMS onboarding, provisioning and inbox | `src/lib/mca/sms/onboarding.ts`, `provisioning.ts`, `inbox.ts`, `src/lib/mca/db/sms-onboarding.ts`, `docs/sms/company-onboarding.md` |
| Vercel frontend | Next.js App Router on Vercel; runtime pool defaults to two connections when `VERCEL` is set |
| Supabase Auth, Postgres and private Storage | `src/lib/supabase/`, `src/lib/mca/supabase-auth.ts`, `supabase-ca.ts`, `docs/supabase-auth.md`, `docs/supabase-billing.md` |
| Background jobs | `src/lib/mca/jobs/`, `/api/cron/jobs`, `docs/background-job-runtime.md`; `../render.yaml`, `Dockerfile.worker`, and `docs/render-deployment.md` are historical deployment references |
| Previous Railway / Render web hosting | `Dockerfile`, `railway.json`, `scripts/railway/`, `../DEPLOYMENT.md`, `docs/milestone-05/provider-activation.md` |
| Encryption, email and API keys | `src/lib/mca/crypto.ts`, `email.ts`, `api-keys.ts` |
| Tests | `tests/`, `src/lib/mca/deals/acceptance.test.ts`, `tests/supabase-auth.test.ts` |
| Migration tooling | `scripts/database/`, `scripts/supabase/`, `drizzle.config.ts` |
| Plans, contracts and verification evidence | `docs/milestone-*/`, `docs/acceptance/`, `docs/supabase-*.md`; `docs/neon-*.md` and `docs/clerk-*.md` are historical |

The app uses Supabase Postgres, Supabase Auth, and private Supabase Storage. The authoritative project is `drubsfvhlggmtyiigwxy` (`fundlane`). See `nextjs-version/README.md` and `nextjs-version/docs/supabase-vercel-migration.md`. SQLite, Neon, Clerk, and filesystem document storage are historical or isolated-test paths. Local runtime data and environment files are excluded from Graphify.

## Supabase agent plugin

The repo's `.agents/plugins/marketplace.json` registers `supabase-community/supabase-plugin` at a pinned upstream commit; `.codex/config.toml` enables `supabase@fundlane` for this trusted project. Restart Codex to discover the Fundlane marketplace. For CLI installation, run `codex plugin marketplace add .` and then `codex plugin add supabase@fundlane` from the workspace root. Supabase authentication remains personal and is never committed. Follow `nextjs-version/docs/agent-task-workflow.md` when choosing a nonproduction project; installing the plugin does not authorize production access or hosted migrations.

The upstream quick installer is `npx plugins add supabase-community/supabase-plugin --target codex --scope project --yes`. Its current Codex adapter writes user-wide configuration even with `--scope project`; the checked-in marketplace and config provide the project scope. See [Supabase plugin documentation](https://supabase.com/docs/guides/ai-tools/plugins) and [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins).

## Graphify setup and refresh

Supabase Auth owns browser identity through `src/proxy.ts`, `src/lib/mca/supabase-auth.ts`, and `src/lib/supabase/`. Application tables remain authoritative for companies, memberships, roles, and financial permissions. Team invitations are application-issued tokens that require a matching verified Supabase email. The old Clerk webhook returns HTTP 410. Legacy password/session HTTP issuance returns 410; API keys retain their existing gateway. See `nextjs-version/docs/supabase-auth.md`.

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

Use Node.js 24+ and pnpm. From `nextjs-version/`, the verification commands are `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Run checks appropriate to the changed behavior. Database tests require a disposable local PostgreSQL cluster (`MCA_TEST_DATABASE_ADMIN_URL`); they create and drop isolated databases and must never use the application Supabase database. Hosted staging acceptance uses real Supabase Auth/Storage and the Vercel frontend.

Refresh the graph after changes and update this guide when module ownership or entry points change. Fetch live Linear status before selecting work or recording completion; milestone snapshots and generated graphs can become stale.

Company billing uses Stripe Checkout and Customer Portal with the Supabase Stripe Sync Engine (`stripe` schema). Application entitlements live in `workspace_billing_entitlements`; historical Clerk `workspace_billing` rows are retained but unused. See `nextjs-version/docs/supabase-billing.md`. `docs/clerk-billing.md` is historical.

Public Fundlane marketing lives at `/`, `/features`, and `/demo`, with components in `nextjs-version/src/components/marketing/` and the demo-delivery endpoint at `/api/marketing/demo`. See `nextjs-version/docs/marketing-site.md` for sales webhook/privacy activation, receiver deduplication requirements, synthetic product captures, and verification. Demo requests use the existing shared request-rate table; no lead data is written to MCA workspaces.

Application Intake: `/intake`, `nextjs-version/src/lib/mca/intake/processing.ts`, and `nextjs-version/scripts/workers/`. See `nextjs-version/docs/application-intake.md` for guided setup, Supabase processing, and verification. Vercel remains the web host.

Client invitation outreach: `nextjs-version/src/lib/mca/applications/`, `nextjs-version/src/components/mca/applications/`, and `nextjs-version/docs/application-outreach.md`.
