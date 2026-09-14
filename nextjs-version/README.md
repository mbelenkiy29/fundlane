# Fundlane

Fundlane uses Next.js 16 / React 19 on Vercel, Supabase Postgres/Auth/private Storage, Stripe test billing, and Render workers for native processing and the Python ChatKit service. Production cutover is a separate controlled operation; see the [migration and deployment runbook](docs/supabase-vercel-migration.md) for the current deployment status.

## Local setup

Use Node.js 24 and pnpm 11.1.2 (`corepack enable`). Run `pnpm install --frozen-lockfile`, copy `.env.example` to an ignored environment file, and configure an isolated Supabase project.

Set `DATABASE_URL` to the transaction pooler URL with the restricted `mca_app` role. Set `DATABASE_URL_UNPOOLED` to a migration connection: direct Postgres where IPv6 is available, or the session pooler on port 5432. Apply `pnpm db:migrate --expected-project-ref=REF`, then `pnpm db:secure --expected-project-ref=REF` with an independently generated `MCA_DB_RUNTIME_PASSWORD`. These commands are release steps, never build hooks. Remote connections always verify TLS, including Supabase's public database CA.

Configure the Supabase URL, publishable browser key and server-only secret key, private buckets, Auth email templates and SMTP as described in [Supabase Auth](docs/supabase-auth.md). Run `pnpm dev`. New users verify email and create a company; migrated users recover their account and set a new password. Local company membership, permissions and API keys remain authoritative.

The runtime pool defaults to two connections on Vercel. Never expose database URLs, service secrets, Stripe credentials, or the encryption key through `NEXT_PUBLIC_*` settings. Only Supabase's URL and publishable key belong in the browser.

## Data and processing

Preserve `MCA_DATA_ENCRYPTION_KEY` and all immutable workspace IDs when transferring existing records. The key is base64url-encoded 32-byte AES-256-GCM material; replacing it makes encrypted values unreadable. Staging uses its own key and synthetic records.

Documents upload directly to private Supabase quarantine storage. Completion verifies the authorized object and queues scanning; only clean objects are promoted. Download authorization issues short-lived private URLs. The worker uses ClamAV and durable Postgres job leases, retries, and the submission outbox. Filesystem storage remains available for isolated local tests and source-file transfer only.

Run the document worker with `node --conditions=react-server --import tsx scripts/workers/run.ts`, and assistant maintenance with `pnpm assistant:worker`. See `Dockerfile.worker` and root `render.yaml`. The Python service receives signed HTTPS requests from Vercel and calls back through the existing live permission checks. Preserve each provider's activation state until verified.

## Billing and integrations

[Stripe billing](docs/supabase-billing.md) preserves Free/1 seat, Starter/$49 monthly/5 seats, and Team/$99 monthly/20 seats. The Stripe Sync Engine owns the separate `stripe` schema; application entitlements are reconciled from verified subscriptions. Historical Clerk billing rows remain available. Production charges are disabled initially.

Application invitations and business messages use the existing transactional delivery adapter. Supabase Auth uses separately configured SMTP. Company SMS, signature providers, sender OAuth, and assistant credit packs retain their individual activation requirements:

- [In-app email and SMS conversations](docs/email-conversations.md)
- [Company SMS onboarding](docs/sms/company-onboarding.md)
- [Provider activation](docs/milestone-05/provider-activation.md)
- [Deal assistant](docs/deal-assistant.md)
- [Conversational assistant](docs/assistant-conversations.md)
- [Python ChatKit service](docs/chatkit-assistant.md)

## Verification

Set `MCA_TEST_DATABASE_ADMIN_URL` to a disposable local PostgreSQL cluster whose user can create databases, then run:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

Tests create randomly named isolated databases, apply checked migrations and drop each database afterward. They never fall back to the application database. Hosted test clusters additionally require `MCA_TEST_DATABASE_DISPOSABLE=true`. HTTP fixtures implement Supabase cookie/session behavior; hosted staging acceptance checks use real Supabase Auth and Storage.

Clerk and Neon are not part of the runtime. Identity is Supabase Auth; Postgres is the Supabase project named by `DATABASE_URL`.

Pipeline calendar setup: [Calendar and Google sync](docs/pipeline-calendar.md). Web hosting remains Vercel; database, authentication, and private storage remain Supabase.

Client invitation workflow and production activation: [Application outreach](docs/application-outreach.md).
