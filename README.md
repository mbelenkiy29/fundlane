# Fundlane

Fundlane is the MCA brokerage workspace application. The active app is in [`nextjs-version/`](nextjs-version/); it uses Next.js 16 and React 19 on Vercel, with Supabase for Postgres, Auth, and private Storage. Clerk and Neon are not part of the runtime.

## Development

Use Node.js 24+ and pnpm. Follow [`nextjs-version/README.md`](nextjs-version/README.md) for database, authentication, setup, and verification instructions. Copy `.env.example` to `.env.local` and supply your own credentials. Never commit environment files or runtime documents.

## Deployment

Live application: https://fundlane.io. The public Next.js app is on Vercel; data, identity, and private files are on Supabase. Follow [`nextjs-version/README.md`](nextjs-version/README.md) for the current stack.

[`DEPLOYMENT.md`](DEPLOYMENT.md) is a September 2026 Render + Neon snapshot, not the current web host. [`render.yaml`](render.yaml) still describes Render workers for native document processing and ChatKit. See [`nextjs-version/docs/render-deployment.md`](nextjs-version/docs/render-deployment.md) for worker configuration.

## Workspace

See [`WORKSPACE_NAVIGATION.md`](WORKSPACE_NAVIGATION.md) for the source map. `vite-version/` and root `docs/` retain the original template references; [`docs/TEMPLATE_README.md`](docs/TEMPLATE_README.md), [`License.md`](License.md), and [`ATTRIBUTION.md`](ATTRIBUTION.md) preserve upstream documentation and attribution.
