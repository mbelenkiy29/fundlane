# Fundlane

Fundlane is the MCA brokerage workspace application. The active app is in [`nextjs-version/`](nextjs-version/); it uses Next.js 16, React 19, Clerk authentication, and Neon Postgres.

## Development

Use Node.js 24+ and pnpm. Follow [`nextjs-version/README.md`](nextjs-version/README.md) for database, authentication, setup, and verification instructions. Copy `.env.example` to `.env.local` and supply your own credentials. Never commit environment files or runtime documents.

## Deployment

[`render.yaml`](render.yaml) defines the Render Docker service and persistent document disk. Neon remains the external database. See [`nextjs-version/docs/render-deployment.md`](nextjs-version/docs/render-deployment.md) for configuration and release checks.

## Workspace

See [`WORKSPACE_NAVIGATION.md`](WORKSPACE_NAVIGATION.md) for the source map. `vite-version/` and root `docs/` retain the original template references; [`docs/TEMPLATE_README.md`](docs/TEMPLATE_README.md), [`License.md`](License.md), and [`ATTRIBUTION.md`](ATTRIBUTION.md) preserve upstream documentation and attribution.
