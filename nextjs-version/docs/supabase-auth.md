# Supabase authentication

Fundlane uses Supabase Auth for verified email/password identities. The server-owned application tables remain authoritative for companies, roles, managers, financial permissions, invitations and seat reservations. The browser receives only the project URL and publishable key. The server secret key must never use a `NEXT_PUBLIC_` name.

## Configuration and email

Configure `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, the restricted runtime `DATABASE_URL`, and the environment's exact `MCA_APP_ORIGIN`. Use different Auth projects for staging and production. Configure production SMTP in Supabase; ordinary previews must never send using production credentials.

Set the Supabase Site URL to the environment's public origin and allow exactly its `/auth/callback` URL. The built-in PKCE email redirect works when the email is opened in the same browser that requested it. For links that work across devices, configure confirmation and recovery email templates to send a token hash to the application callback:

- Confirmation: `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=signup&next=/onboarding`
- Recovery: `{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`

If the email template includes `{{ .Token }}`, the verification screen also accepts that code. Only confirmation and recovery token types are accepted; callback destinations are restricted to onboarding or password setup. Require verified email and a minimum 12-character password in project Auth settings. Signup and password reset also validate password length on the application server.

Company invitations use the existing `MCA_EMAIL_WEBHOOK_URL` business-email integration. They contain a server-generated, hashed, 72-hour application invitation token. The invitee must also authenticate with a verified matching Supabase email. Resends rotate the token while preserving the invitation identity and reserved seat. Deactivation or acceptance invalidates outstanding links. Delivery failures preserve pending reservations for an administrator to retry; development-only delivery previews are returned when no business email provider is configured.

## Sessions and authorization

`src/proxy.ts` refreshes Supabase SSR cookies. `supabase-auth.ts` validates the current user, signed claims, user/session ownership, and the live provider session on every protected request. It reads only `id`, `user_id` and `not_after` through the non-exposed `mca_private.auth_sessions` view installed by the runtime-security script. Missing security configuration fails closed. It also rejects application-recorded revoked sessions, unverified email, anonymous or banned accounts, and migrated accounts still awaiting password setup.

The `mca_workspace` HTTP-only cookie only selects a workspace. Every request joins that workspace to the mapped user and an active local membership; changing the cookie cannot grant access. Company switching performs this same membership check before setting the cookie. API keys continue through the existing scope/rate-limit gateway and cannot access interactive-only operations.

Signout records an immediate local revocation before calling Supabase signout. Password reset signs out other provider sessions. Delegated ChatKit callbacks recheck the live Supabase session, mapped identity, current membership, and existing signed request state. Local deactivation removes in-flight ChatKit requests and prevents every subsequent membership-authorized action without waiting for JWT expiry.

## Identity migration

Apply migration `0025_supabase_auth.sql` and run the checked identity import tooling. Preserve local user/workspace IDs and historical Clerk columns. Each migrated identity has a unique `users.supabase_user_id` and trusted admin metadata `mca_user_id` and `mca_migration_pending: true`. Do not put those values in editable `user_metadata`.

Matching email alone never merges old accounts. Historical accounts require an explicit migration ID. An accepted application-issued invitation may link a new pending placeholder only when it has no previous provider identity, local password, or established membership. An invitation from another company cannot claim a historical account or grant access to its other companies. Conflicting identities stop for administrator reconciliation. Migrated users initiate recovery themselves; a successful password update clears the migration gate server-side. The importer sends no emails.

Migration invalidates old provider/legacy invitation tokens while preserving pending memberships. New and resent invitation hashes carry a `supabase:` prefix, allowing identity-import reruns to preserve replacement links while retiring legacy links. Supabase invitation acceptance never accepts an unversioned legacy hash. Administrators resend from Team settings when ready. The old Clerk webhook returns HTTP 410 and cannot mutate companies or memberships after cutover. Historical Clerk helper code remains solely for old migration tooling and regression fixtures; it is not imported by active authentication, pages or webhooks.

## Verification

Run `tests/supabase-auth.test.ts` against a disposable PostgreSQL database for identity anti-spoofing, tenant isolation, all four local roles, invitation single-use, and provider/local session revocation. The Supabase HTTP protocol fixture uses signed RSA JWTs, JWKS, real SSR cookie decoding and a private session view; foundation, billing, deal, document, intake and import HTTP suites therefore exercise the actual application authentication gateway.

Before production, also verify actual staging Supabase signup, email delivery/callback, recovery, refresh, logout, multi-company selection, invitation resend/deactivation, and live session revocation. A protocol fixture does not verify SMTP configuration or a hosted Supabase deployment.

The opt-in hosted runner starts an isolated local Next.js instance using real staging Auth and the restricted database role. From `nextjs-version/`, load staging credentials from a private, ignored environment file and run:

```sh
MCA_AUTH_VERIFICATION_ENV=staging node --env-file=.env.staging.local \
  --conditions=react-server --import tsx scripts/supabase/verify-auth.ts \
  --expected-project-ref=STAGING_PROJECT_REF --allow-synthetic-writes
```

The supplied `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` must belong to that exact staging project. The database must already have the application migrations and private live-session view. The runner checks that the connected role is `mca_app` (override only with the actual restricted role name through `MCA_AUTH_VERIFICATION_RUNTIME_ROLE`). It refuses production execution, sends no signup/invitation/recovery delivery requests, generates synthetic `example.test` accounts, and removes only its own identities and company records. Admin-generated signup/recovery links exercise the real callbacks without SMTP. A private per-run report under `.migration/auth-verification/` records checks and cleanup IDs without credentials or tokens. If the process is forcibly terminated, use that report to remove its remaining synthetic records before removing `running.lock` and rerunning. This verifies the local checkout against hosted services; deployed browser behavior and SMTP remain separate checks.

### Staging verification — 2026-09-12

The isolated project `drubsfvhlggmtyiigwxy` passed nine hosted checks using real Supabase Auth and the restricted `mca_app` database role: password login/SSR cookies/identity mapping; forged company selection; immediate local role changes; password update/token refresh/other-session revocation; verified invitation acceptance and replay rejection; company deactivation while preserving another membership; logout token replay rejection; generated recovery-token callback/password setup/migration-gate removal; and generated signup-token callback/new company creation. Supabase Admin `generateLink` exercised signup and recovery without delivering email. Synthetic identities and company records were removed afterward.

The Vercel staging landing, sign-in, recovery and reset screens were also inspected in Chrome at desktop size and 390×844. A disposable staging account signed in through the deployed UI, reached its company dashboard, and opened the application company selector. SMTP delivery remains a separate deployment check.

The staging Site URL is `https://fundlane-staging-michael-belenkiys-projects.vercel.app`; only its `/auth/callback`, `/auth/callback?next=/onboarding`, and `/auth/callback?next=/reset-password` redirects are configured. Email confirmation is enabled, anonymous sign-in is disabled, and the hosted minimum password length is 12.
