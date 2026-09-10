# Render deployment

The root `render.yaml` runs `nextjs-version/Dockerfile` with Node 24, Next standalone output, and ClamAV. Use the `1c-2g` service (2 GB RAM for the app and scanner) and a 10 GB persistent disk mounted at `/data`. Neon is external: no Render database is provisioned.

## Environment

Copy the existing production pooled/direct Neon URLs, encryption key, upload/artifact token secrets, Clerk production credentials/webhook secret, and workspace-bound Postmark configuration into Render's environment store. Do not regenerate the encryption key or publish secrets in Git. `.env.example` lists optional integrations; configure their credentials only when the corresponding provider is available. Keep development-only Clerk billing disabled.

The Docker build requires `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`; runtime requires the matching `CLERK_SECRET_KEY`. The production Clerk instance uses `fundlane.io`. Set `MCA_APP_ORIGIN=https://fundlane.io` and allow the apex/www origins. Render supplies `PORT`; the entrypoint binds `0.0.0.0`. `/sign-in` is the health check.

Only `/data` persists: documents use `/data/documents` and ClamAV signatures use `/data/clamav`. The app runs as the unprivileged Node user. Scanner failures block document processing. Keep one instance because document bytes are local to this disk. Do not attach a second independent document filesystem to a live writable deployment without copying and reconciling existing objects first.

## Release

1. Run `pnpm typecheck`, `pnpm lint`, and a production `pnpm build` with the production publishable key.
2. Validate with `render blueprints validate ../render.yaml` and push the app/configuration to `mbelenkiy29/fundlane`.
3. Provision the service/disk and transfer runtime secrets from the existing secret store.
4. Verify Neon migrations and Clerk identity mappings before traffic cutover. Apply schema migrations as a separate reviewed release step, never automatically against a preview database URL.
5. Wait for a live deployment, verify sign-in/assets and unauthorized API rejection, and verify custom-domain certificates before updating apex/www DNS. Retain Clerk and mail DNS records.
6. Check Clerk webhook signatures, persistent storage, and antivirus scanning. The migrated owner verifies their email and sets their own password through the activation screen.

GitHub Actions validates types and lint on main and pull requests. Blueprint auto-deploy waits for passing GitHub checks. Production database tests require the isolated verification environment documented in the active README.

## Optional providers and jobs

Business email, intake receipts, Drive import, AI extraction, signing, and SMS each require their provider credentials and any provider approvals. Deployment does not verify pending senders or approve SMS registrations. The existing SMS scheduler entrypoint is `scripts/railway/sms-jobs.mjs`; enable it only with a configured SMS provider and `MCA_SMS_JOB_TOKEN`. Intake jobs use `/api/mca/intake/jobs/run` with `MCA_INTAKE_WORKER_TOKEN`. Communications jobs currently require an administrator session. Do not replace those authorization checks with an unauthenticated cron endpoint.
