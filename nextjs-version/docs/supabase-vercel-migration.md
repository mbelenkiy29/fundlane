# Fundlane production deployment

GitHub `mbelenkiy29/fundlane`, branch `main`, deploys automatically to the existing Vercel `fundlane` project. The root is `nextjs-version`; Node 24 and pnpm 11.1.2 are pinned. Use `pnpm install --frozen-lockfile` and `pnpm build`.

## Authoritative services

Supabase project `drubsfvhlggmtyiigwxy` (`fundlane`, previously named staging) owns database records, Auth identities, and private Storage. Existing data and users are preserved. Do not reconnect to Neon or import historical Clerk identities as part of deployment repair. The retired Clerk webhook responds with HTTP 410.

Production origin: `https://fundlane-michael-belenkiys-projects.vercel.app`. Configure this as `MCA_APP_ORIGIN` and the Supabase Auth Site URL. Allow `/auth/callback`, `/auth/callback?next=/onboarding`, and `/auth/callback?next=/reset-password`; retain existing staging callbacks.

## Environment

Vercel Production requires `DATABASE_URL` using the restricted `mca_app` role through the transaction pooler, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_URL`, and server-only `SUPABASE_SECRET_KEY`. All must identify the same Supabase project. Hosted runtime validation rejects other database providers or mismatched project references.

Preserve existing `MCA_DATA_ENCRYPTION_KEY` and document/upload/closing signing secrets. Set `MCA_DOCUMENT_STORAGE_PROVIDER=supabase`, `MCA_DB_POOL_MAX=2`, and private buckets `fundlane-documents`, `fundlane-quarantine`, `fundlane-assistant`, and `fundlane-artifacts`. Never deploy migration-owner credentials or `MCA_DB_RUNTIME_PASSWORD` to Vercel. Preserve provider activation flags; a working deployment does not activate billing, AI, SMTP, or native workers.

## Verification and release

Run `pnpm typecheck`, `pnpm lint`, `pnpm test` with an isolated `MCA_TEST_DATABASE_ADMIN_URL`, and `pnpm build`. The assistant function has a 300-second hosting limit and aborts execution by 270 seconds to leave cleanup time.

Inspect schema compatibility and RLS using read-only queries before deployment. Apply no destructive resets or migration replays to existing data. Release via a reviewed change merged into `main`, then verify GitHub checks, Vercel Ready status, and matching Git commit SHA. Test Auth cookies, refresh, recovery, sign-out, company isolation, and private Storage using temporary synthetic fixtures with exact cleanup. Auth email delivery requires separately configured SMTP; generated verification links do not prove email delivery.

After Supabase writes, repair forward on Supabase; never roll back to a stale Neon database. Keep credentials out of release evidence. Refresh Graphify from the workspace root after source changes.
