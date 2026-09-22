# Auth ownership foundation — production database release

Date: 2026-09-21. Target: Supabase `drubsfvhlggmtyiigwxy` (`fundlane`, production).

## Changes verified locally

- Explicit ownership for new company onboarding; same-company active-member transfer.
- Current owner role/deactivation protection and atomic transfer audit records.
- Separate platform grants, with live-session and same-session AAL2 requirements.
- Signup/reset weak-password errors and password length field guidance.

## Database release

Production's Drizzle ledger ended at `0039_fundlane_forms`, whose SHA-256 matched
the local migration. Existing migrations `0040` through `0045` and new migration
`0046_company_ownership` were applied in order through the authenticated Supabase
CLI linked to the explicit production project. This release used the CLI query
transport because no migration-owner database URL was available in the workspace.

The SQL transaction locked the Drizzle ledger, checked that its baseline had not
changed, executed the checked-in migration SQL, and inserted the exact SHA-256 and
journal timestamp for each migration into `drizzle.__drizzle_migrations`. A 5-second
lock timeout and 60-second statement timeout bounded contention. Permission and RLS
assertions ran before commit. No schema resets or migration replay were used.

| Migration | SHA-256 |
| --- | --- |
| 0040_document_worker_heartbeat | `5f5b4ce18d147b8bab8fc5c1b1143aef9fab0a5197cee3c826b7d2794046eb02` |
| 0041_underwriting_policy_v2 | `a9f472635bdc324dc4be7cb8cd0138cb0a454594fc8f4763b0a400514513d3d5` |
| 0042_submission_duplicate_identity | `f29b2107a18c96876084a0b8dc1ada9dcb69663ea102354bdce290c37f9556a5` |
| 0043_closing_upload_and_offer_expiry | `750f873335cc62de8a4cb490d6f4648cf510aaed21f738597efb981fc2b69a68` |
| 0044_money_remittance | `3b40730f44f9daa96bdd4bb6caec2ee4ad89ab8b6c7cc28dd9de06518284be03` |
| 0045_tenancy_ein_hmac | `44b2024b6c111067d3b6cb86f15d280d47f6cce8b9c55ef55e4c073ff7e3d889` |
| 0046_company_ownership | `55e17aada092f1be0800fdb6794a1998c1115cec20e5e88942f6d5a1c30ba6db` |

Post-commit verification confirmed all seven hashes and timestamps, RLS enabled on
both new tables, `mca_app` SELECT-only privileges on `platform_admin_grants`, and
runtime CRUD privileges on `workspace_owners`. Browser roles have no privileges on
either new table. Offer-expiry and receipt-date backfills have no remaining nulls.
The company count remained three. No existing owner assignments or platform-admin
grants were inferred or created.

## Verification results

- Auth/ownership/foundation focused suites: 43 tests passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- `pnpm lint`: zero errors, 17 warnings in existing files.
- Full `pnpm test`: 814 tests; 808 passed, 5 failed, 1 skipped.
- All five failures reproduced from an isolated archive of unchanged HEAD:
  - `assistant.test.ts`: funder submission/reminder approval state.
  - `edge-control.test.ts`: revoked-generation rejection.
  - `seed-ben.test.ts`: expected seed/view count (100 versus 180).
  - `submissions-offer-links.test.ts`: two undefined-versus-null assertions.

Tests used disposable local Postgres databases, not production.

## Deployment state

This is a database release only. The modified application code has not been deployed
to Vercel. Google login, five-user trials, the new paid catalog, billing suspension,
and the platform console remain subsequent implementation work. Initial ownership
assignments and platform-admin grants require confirmed immutable identities.
