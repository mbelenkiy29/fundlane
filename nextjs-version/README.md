# MCA workspace app

This Next.js app implements the MCA Foundation and workspace milestone with persistent, tenant-isolated data, server-side role policies, invitations, session authentication, account recovery, and scoped API keys.

## Local setup

Node.js 24 or later and access to a Neon Postgres database are required.

1. Configure a development Neon database using `DATABASE_URL` and `DATABASE_URL_UNPOOLED`, then apply checked migrations with `pnpm db:migrate`.
2. Configure Clerk's development keys using the linked MCA application. See [Clerk setup and migration](docs/clerk-auth.md).
3. Run `pnpm install`, then `pnpm dev`. The existing `/sign-up` and `/sign-in` screens use Clerk.
4. New owners verify email, create/select their company, and optionally invite employees. Existing accounts must be imported before cutover and verify email/set a new password once.

There is no default login or legacy-session fallback. Production account migration and deployment are separate release steps.

## Production requirements

- Use Node.js 24 or later.
- Set pooled `DATABASE_URL` for application traffic and direct `DATABASE_URL_UNPOOLED` for Drizzle migrations and controlled data transfer. The application uses a bounded `pg` pool and verified TLS.
- Set `MCA_DATA_ENCRYPTION_KEY` to a base64url-encoded 32-byte key. Sensitive deal fields use AES-256-GCM with the immutable workspace ID as authenticated data.
- Set `MCA_APP_ORIGIN` to the public HTTPS origin and configure `MCA_EMAIL_WEBHOOK_URL`. Business email delivery requires a configured provider; authentication and invitations use Clerk.
- Keep `MCA_EMAIL_WEBHOOK_TOKEN` and Clerk credentials in the deployment secret store. API-key secrets and session/invitation/recovery tokens are never persisted in plaintext.

The email webhook receives JSON with `recipient`, `template`, `actionUrl`, and `expiresAt`. It must return a 2xx response before the app records delivery as sent.

Document bytes remain in `MCA_DOCUMENT_STORAGE_PATH` (default `data/documents`); Neon stores their metadata and does not replace or copy the filesystem objects. Back up and mount that path whenever document files exist.

Build and start the production server with `pnpm build` and `pnpm start`. Configure both database URLs, document storage, encryption key, public origin, and email webhook in the runtime environment before `pnpm start`.

The Render deployment configuration is in the repository root `render.yaml`; see [Render deployment](docs/render-deployment.md). It retains Neon and mounts `/data` for documents and antivirus signatures.

The previous Fundlane Railway deployment uses the checked Dockerfile and `railway.json`, with Neon metadata and a persistent `/data` volume for document bytes and antivirus signatures. Deployment IDs, verification evidence, and outstanding email/SMS/signature activation steps are recorded in [Milestone 5 provider activation](docs/milestone-05/provider-activation.md). Closing Postmark credentials are bound to exact workspace/sender identities; a pending sender still requires a successful provider test before use.

## Verification

Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. Database tests create uniquely named databases on the protected Neon verification branch, apply the same Drizzle migrations, pass the isolated pooled URLs to child servers, and forcibly drop each database during teardown. They never truncate or reuse migrated application data.

## Company SMS onboarding

Company signup, business review, employee number provisioning and two-way inbox setup are documented in [Company SMS onboarding](docs/sms/company-onboarding.md). Apply its checked migrations before enabling the new screens. Twilio ISV eligibility, per-company carrier approval and Advanced Opt-Out confirmation are separate activation gates; code deployment alone does not enable sending.

Company subscriptions are development-only. See [Clerk Billing setup, reconciliation, and release requirements](docs/clerk-billing.md).

## Deal AI assistant

AI Assistant is available immediately below Home in the sidebar and within each selected deal. It supports private workspace chats, scoped deal actions, per-user monthly credits, admin credit packs and low-balance alerts. It performs requested internal work and requires exact-preview approval for merchant texts, funder reminder emails, and submissions. It is disabled by default. Apply migrations 0020 and 0021 and configure `MCA_ASSISTANT_ENABLED=true`, `OPENAI_API_KEY`, and `MCA_ASSISTANT_MODEL` before activation. See [configuration, approval behavior, and verification](docs/deal-assistant.md).

Credit packs require separate Stripe test-mode activation. Admin alert email uses the transactional adapter and the assistant account-maintenance worker. In-app alerts remain available without email configuration. See the assistant guide for the worker and provider verification steps.

The conversational assistant adds private memory, cited research, clarification replies and generated files. See [conversational assistant setup and operations](docs/assistant-conversations.md) for migration 0022, feature flags, scanner/storage requirements and the supervised maintenance worker.
