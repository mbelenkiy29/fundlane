# Fundlane

Fundlane is the MCA brokerage workspace application. The active app is in [`nextjs-version/`](nextjs-version/); it uses Next.js 16 and React 19 on Vercel, with Supabase for Postgres, Auth, and private Storage. Clerk and Neon are not part of the runtime.

## Start a development task

1. Read [`AGENTS.md`](AGENTS.md), the [source map](WORKSPACE_NAVIGATION.md), and [the app setup](nextjs-version/README.md). The active implementation is in `nextjs-version/`; `vite-version/` and root `docs/` are template references.
2. Read the assigned [MCA Linear issue](https://linear.app/michael-belenkiy/project/mca-1e94b0617388) or GitHub issue and its acceptance criteria. Create a fresh cloud coding session, worktree, or VM on a feature branch from `main`.
3. Follow the [agent and developer task workflow](nextjs-version/docs/agent-task-workflow.md) to select a disposable PostgreSQL test cluster or a synthetic-data staging Supabase project, run checks, and open a PR for review. A fresh code VM **does not** isolate the database by itself. Never use production credentials or data in an agent environment.

Fundlane already has a Drizzle schema and checked SQL migrations in `nextjs-version/drizzle/`; application queries use `pg` and Supabase Auth/Storage use Supabase libraries. Use those sources to understand the app. Do not add Prisma as a second schema or migration authority just to help agents navigate.

## Development

Use Node.js 24+ and pnpm 11.1.2. From `nextjs-version/`, run `corepack enable` and `pnpm install --frozen-lockfile`. Follow [`nextjs-version/README.md`](nextjs-version/README.md) for database, authentication, setup, and verification instructions. Copy `.env.example` to an ignored `.env.local` and supply only nonproduction credentials for development. Never commit environment files or runtime documents.

## Deployment

Live application: https://fundlane.io. See [current deployment and verification](DEPLOYMENT.md).

The website runs on Vercel. [`render.yaml`](render.yaml) retains the document and messaging workers; the old Render website and Python ChatKit service are suspended. See [the worker deployment audit](nextjs-version/docs/render-deployment.md) for configuration and release checks. Agent PRs do not authorize production migrations, deployments or provider activation.

## Workspace

See [`WORKSPACE_NAVIGATION.md`](WORKSPACE_NAVIGATION.md) for the source map. `vite-version/` and root `docs/` retain the original template references; [`docs/TEMPLATE_README.md`](docs/TEMPLATE_README.md), [`License.md`](License.md), and [`ATTRIBUTION.md`](ATTRIBUTION.md) preserve upstream documentation and attribution.
