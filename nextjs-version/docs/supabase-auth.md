# Supabase authentication

Fundlane uses Supabase Auth for verified email/password identities. The server-owned application tables remain authoritative for companies, roles, managers, financial permissions, invitations and seat reservations. The browser receives only the project URL and publishable key. The server secret key must never use a `NEXT_PUBLIC_` name.

## Configuration and email

Configure `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, the restricted runtime `DATABASE_URL`, and the environment's exact `MCA_APP_ORIGIN`. Use different Auth projects for staging and production. Configure production SMTP in Supabase; ordinary previews must never send using production credentials.

Set the Supabase Site URL to the environment's public origin (without a trailing slash). Allow that exact host's `/auth/callback` and its continuation query variants in Auth redirect settings; the historical fixed-query allowlist below is insufficient for invitation flows. The built-in PKCE email redirect works when the email is opened in the same browser that requested it. For links that work across devices, configure these **Supabase Go HTML email templates**:

Confirmation:
```html
<a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&amp;type=signup&amp;redirect_to={{ .RedirectTo | urlquery }}">Confirm your email</a>
```

Recovery:
```html
<a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&amp;type=recovery&amp;redirect_to={{ .RedirectTo | urlquery }}">Reset your password</a>
```

`urlquery` is the Go template function: encode the entire `.RedirectTo` as **one query value**. Do not append `?token_hash` to `.RedirectTo`, which already contains `?next=...`, or hardcode `next=/onboarding`. HTML `&amp;` separators become `&` when the link is followed. These links supply the actual `.TokenHash` to `verifyOtp`; they do not need a PKCE `code`, browser verifier, or `.ConfirmationURL`. Do not substitute `.Token` for `.TokenHash`.

The application creates `.RedirectTo` using its canonical origin and sanitized continuation. The callback independently validates the encoded URL's exact origin and `/auth/callback` path, extracts `next`, and applies its destination allowlist again. It never redirects to `.RedirectTo` itself. Untrusted or absent values fall back to onboarding (through password setup for recovery). Carrying this non-authorizing destination in the URL supports cross-device verification; no server-stored continuation identifier is required. Possession of an invitation token still requires the matching verified identity and explicit server-side acceptance.

Recovery requests wrap the final destination in `/reset-password?next=...`. Both PKCE and token-hash callbacks preserve that destination through password setup; success returns to the invitation or other allowed final destination. Expired recovery links return to the recovery request screen with that same sanitized destination. Migrated identities still use the existing server-only `allowPasswordSetup` gate and metadata-clearing process.

If the email template includes `{{ .Token }}`, the verification screen also accepts that code. Only email/signup and recovery token types are accepted; callback destinations are explicitly allowlisted. Require verified email and a minimum 12-character password in project Auth settings. Signup and password reset also validate password length on the application server.

Company invitations use the existing `MCA_EMAIL_WEBHOOK_URL` business-email integration. They contain a server-generated, hashed, 72-hour application invitation token. The invitee must also authenticate with a verified matching Supabase email. Resends rotate the token while preserving the invitation identity and reserved seat. Deactivation or acceptance invalidates outstanding links. Delivery failures preserve pending reservations for an administrator to retry; development-only delivery previews are returned when no business email provider is configured.

## Sessions and authorization

`src/proxy.ts` refreshes Supabase SSR cookies. `supabase-auth.ts` validates the current user, signed claims, user/session ownership, and the live provider session on every protected request. It reads only `id`, `user_id` and `not_after` through the non-exposed `mca_private.auth_sessions` view installed by the runtime-security script. Missing security configuration fails closed. It also rejects application-recorded revoked sessions, unverified email, anonymous or banned accounts, and migrated accounts still awaiting password setup.

The `mca_workspace` HTTP-only cookie only selects a workspace. Every request joins that workspace to the mapped user and an active local membership; changing the cookie cannot grant access. Company switching performs this same membership check before setting the cookie. API keys continue through the existing scope/rate-limit gateway and cannot access interactive-only operations.

Signout records an immediate local revocation before calling Supabase signout. Password reset signs out other provider sessions. Delegated ChatKit callbacks recheck the live Supabase session, mapped identity, current membership, and existing signed request state. Local deactivation removes in-flight ChatKit requests and prevents every subsequent membership-authorized action without waiting for JWT expiry.

## Identity migration

### Company ownership and platform authorization

Migration `0046_company_ownership.sql` adds explicit `workspace_owners` and separate
`platform_admin_grants`. New company onboarding records the creator's membership as
owner in the same transaction. Existing companies remain unassigned until an operator
confirms their owner; no ownership or platform privileges are inferred from old roles.

`POST /api/workspace/ownership` accepts `{ "membershipId": "..." }` from the current
owner's authenticated session. It requires an active same-company successor, promotes
that successor to company admin if necessary, and records the transfer atomically in
the audit log. The previous owner remains an admin. Member edits and deactivation use
the same workspace lock so they cannot race a transfer or remove the current owner.

The company role named `super_admin` is **not** a platform administrator. Platform
handlers must use `requirePlatformAdmin()`, which requires a live Supabase identity,
an unrevoked database grant, and signed `aal2` claims belonging to the same session.
This is the authorization foundation; console screens and MFA enrollment/challenge
screens are subsequent implementation work.

Platform grants are provisioned only through the trusted database operator connection,
using the immutable local user ID and recording `granted_at`, `granted_by`, and `reason`.
Revoke with `revoked_at`; the next authorization check rejects the grant. Never expose
grant writes through company settings or user-editable Supabase metadata. Run
`pnpm db:secure` after migrations: the runtime role receives SELECT only on this table,
and browser roles receive no access. Existing-company ownership assignment must also
validate an active administrative membership in the same company before insertion.

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
