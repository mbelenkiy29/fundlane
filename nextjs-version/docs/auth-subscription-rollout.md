# Authentication and company-subscription rollout

## Recovery release checkpoint — 2026-09-21

- Implementation commit `8202a1e` pushed to `mbelenkiy29/redoing-auth`.
- Full regression confirmation: 968 tests, 967 passed, one skipped, zero failed. Production build from the committed-source snapshot passed.
- Applied additive migration `0048_billing_recovery`, ledger timestamp `1790035200002`, SHA-256 `d12ce4e1ec6c70ca501f78f025431e51b057d49fa9fe4d5dd0143d1ed4c122c0`.
- Production readback verified the new marker column, three companies with three legacy exemptions, and two active platform-admin grants.
- Recovery application deployed from the isolated `8202a1e` source snapshot as Vercel
  `FeCKA2FnNUfi1SrRfUu2ZRF32yYX`, immutable URL
  `https://fundlane-kcl22nj26-michael-belenkiys-projects.vercel.app`, aliased to
  `https://fundlane.io`. Vercel's production build passed. Deployment metadata records
  implementation `8202a1e` and acceptance checkpoint `e0e10af`.
- Post-deploy smoke at **2026-09-22 03:02 UTC**: `/` and `/sign-in` returned 200;
  `/settings/billing` and `/platform` redirected unauthenticated browsers (307);
  billing GET/cancel POST, platform-company GET and unauthenticated cron returned 401.
  Authenticated maintenance returned 200: three scanned, zero reconciliation errors,
  zero pending notifications. Private evidence: `recovery-production-smoke.json`.
- Supabase Vault/`pg_net` transport request **299** independently returned 200 with
  the same maintenance result and no timeout. The ten-minute job remains active.
  Requests 296–298 returned 404 before this release; the endpoint and transport are
  now verified. Post-deploy database readback still has all three legacy-exempt,
  non-manually-paused companies.
- Core provider run 9 passed **21 checks**, including real settlement retaining manual
  suspension and outbound reapproval. Signed webhook run 2 passed genuine out-of-order
  cancellation/older-active delivery. Processing runs 7–8 passed real SCA/processing
  renewals and total-debt shortfall. See `docs/acceptance/` for evidence and remaining
  hosted browser acceptance. Live Stripe billing remains unactivated; this deployment
  does not convert legacy companies or configure external providers.

## Approved commercial contract

- Supabase verified email/password and Google sign-in.
- Monthly USD subscription: $399 includes one user; users 2–10 add $79 each,
  users 11–20 add $69 each, users 21+ add $59 each (graduated bands).
- 14-day trial without a card, at most five active/pending users including the owner.
- Trial expiry pauses business access and automation until paid activation.
- Failed paid renewals start one seven-day grace period; failed attempts do not reset it.
- Paid recovery cannot clear an independent manual suspension.
- Company owners/admins manage their subscription; platform administrators use separate
  grants and MFA for cross-company administration.

## Provider activation still required

The existing production Supabase project is `drubsfvhlggmtyiigwxy` and public origin is
`https://fundlane.io`. The user chose to finish implementation before provider activation.
Do not describe this rollout as fully live merely because migrations were applied.

### Fundlane Stripe account

Use a distinct Fundlane account under the Sentinel Tech Solutions Stripe organization
if separate payment balances/reporting are desired. Stripe Organizations centralizes
access across accounts; this is different from a Stripe Connect connected account.
Creating/activating the new business account is a Dashboard/business-onboarding step.
The account must be confirmed before provisioning prices or configuring live keys.

Once the intended account is available, provision and inspect the catalog with:

```sh
# Read-only inspection. Credentials are loaded from a private environment file.
node --env-file=/private/path/billing.env --conditions=react-server --import tsx \
  scripts/stripe/setup-catalog.ts --expected-account=acct_CONFIRMED_ACCOUNT

# Create missing Fundlane-specific products/prices/portal only after reviewing destination.
node --env-file=/private/path/billing.env --conditions=react-server --import tsx \
  scripts/stripe/setup-catalog.ts --expected-account=acct_CONFIRMED_ACCOUNT --apply
```

Set `MCA_STRIPE_MODE`, `STRIPE_SECRET_KEY`, both returned price IDs, a dedicated portal
configuration, and a webhook signing secret in the target deployment. Use the precise
catalog/permission/event contract in [supabase-billing.md](supabase-billing.md).
The script never changes an existing price or another application's portal.
Provisioning also needs account-read, product-write, price-write, and portal-configuration
permissions; the deployed runtime key can use the narrower permissions listed in the
billing guide. Do not deploy the provisioning key merely to avoid configuring runtime
permissions.

### Google and auth email callbacks

Google was disabled in hosted Supabase when checked during this rollout. Create a
Google Web OAuth client with callback:

`https://drubsfvhlggmtyiigwxy.supabase.co/auth/v1/callback`

Configure the client ID/secret in Supabase, enable the provider, and configure the
application callback allowlist and confirmation/recovery templates described in
[google-auth-mfa.md](google-auth-mfa.md). Verify both ordinary and invitation-originated
signup/recovery on a second browser/device. Provider-generated test links alone do
not prove real email delivery.

### Notifications and scheduler

Configure the production billing notification transport, verify its sending domain, and
test payment-failure delivery. Keep delivery retries and invoice reconciliation enabled
even when a company is paused. Production uses Supabase `pg_cron` job
`fundlane-billing-maintenance` every ten minutes (`*/10 * * * *`). It calls
`https://fundlane.io/api/cron/billing` through `pg_net`, using the credential named
`fundlane_billing_cron` in Supabase Vault. The matching sensitive `CRON_SECRET` is
configured in Vercel production. Rotate both together and redeploy to pick up the new
environment value. Vercel Hobby cannot run this interval, so no Vercel cron is configured.
Do not expose scheduler credentials to the browser or include them in SQL logs.

## Initial platform identities

The user explicitly requested platform access for:

- `mike@sentineltechsolutions.io`
- `ben@sentineltechsolutions.io`

Both were confirmed as verified, mapped Supabase users in the intended project. Grant
through the database operator connection using the confirmed immutable local user IDs,
with a reason and audit record; never infer platform authority from company roles.
Each user must complete MFA before accessing the console. These grants are separate
from selecting a company's owner for ownership transfer and billing-email delivery.

## Release boundary

### Local verification — 2026-09-21

- Latest full-suite run: 853 tests, 851 passed, one skipped, one failed. The failure
  was the platform payment-summary assertion missing the new refund/dispute fields.
- After completing platform controls/reporting and updating their coverage, the
  platform-console and platform-routes suites passed all 10 tests, including that
  previously failing assertion. The full suite was not rerun after these final changes.
- Production build passed after the final platform changes. Account security is
  explicitly request-rendered so build-time prerendering does not attempt authentication.
- Typecheck passed; lint passed with 17 existing warnings.
- Migration 0047 and the two requested platform grants were applied after local
  verification. Application deployment and real-provider acceptance are tracked below.

### Production database and scheduler — 2026-09-21

- Applied `0047_company_subscriptions` in one transaction with a locked migration
  ledger, exact 0046 baseline assertion, short lock timeout, and precommit RLS/grant
  and legacy-access assertions.
- Verified ledger timestamp `1790035200001` and SHA-256
  `13dd834ba9731e84a820810f836f4f7c2055d110e9d222e5a6d8a454eeb50972`.
- All three existing companies have explicit legacy exemptions; no trial or charge
  was started by the migration.
- Applied and audited platform grants for the confirmed immutable identities of Mike
  and Ben. Two active platform grants verified; console still requires same-session MFA.
- Configured Supabase Vault/pg_cron/pg_net billing schedule and matching Vercel secret.
- Initial deployment was rejected by Vercel Hobby's cron-frequency restriction.
  Removed the Vercel cron configuration and deployed using Supabase scheduling.
- Vercel deployment `Fu9bEHLcrhD8dwCWdNu51ohJLivm` successfully built and aliased
  `https://fundlane.io`; immutable deployment URL:
  `https://fundlane-fr94384xv-michael-belenkiys-projects.vercel.app`.
- Live smoke checks: sign-in 200; account-security/platform redirect unauthenticated
  visitors to sign-in; platform API and unauthenticated cron return 401.
- Authenticated production maintenance returned 200, scanned 3 companies, reconciled
  0 Stripe subscriptions, reported no errors, and had no notifications to send.
  This verifies execution, not live Stripe or email-provider acceptance.
- First scheduled Supabase HTTP call occurred before deployment completion and returned
  404. Post-deployment `pg_net` request 221, using the Vault credential and identical
  endpoint/headers, returned 200 without timeout/error and the expected three-company
  maintenance response. The cron job is active on `*/10 * * * *`.

1. Run local PostgreSQL tests, typecheck, lint and build.
2. Exercise actual Stripe test Checkout, paid increases, reductions, cancellation,
   failed renewal, notification delivery, pause, and paid recovery.
3. Exercise Google, email/password, invitation continuation and MFA against hosted Auth.
4. Apply checked migrations to the explicit intended Supabase project; verify hashes,
   RLS, runtime grants, and preserved legacy-company access.
5. Deploy the verified commit through the Vercel production release path.
6. Confirm cron execution, webhook delivery, company isolation and billing recovery.

See [auth-ownership-release-2026-09-21.md](acceptance/auth-ownership-release-2026-09-21.md)
for the earlier database-only release through migration 0046. Later local migrations
must not be assumed deployed based on that evidence.
