# Platform production refresh and fresh start

The portal reads existing PostgreSQL projections through the existing super-admin/MFA guards. A shared visible-tab clock refreshes server pages and client queues every 30 seconds, on tab return, and on demand. Dashboard GETs never call Stripe or reconcile billing. Successful database snapshots and Stripe read timestamps are separate; a Stripe read older than 15 minutes is stale. Existing signed webhooks, immediate reconciliation and ten-minute maintenance remain the writers.

Financial selections apply search, dates and currency before calculating totals across every page. Invoice status also selects linked payments. Adjustments have independent filtering. Totals retain integer cents and currencies separately, including amounts beyond JavaScript's safe integer range.

## Release prerequisites

Production is Supabase `drubsfvhlggmtyiigwxy`, Vercel project `prj_CfNSMe4XUy8ln3sGi60TD01fijVU`, and `https://fundlane.io`. The reviewed Stripe Sync Engine account is `acct_1SoUZ2PmDkyxVWee`. Verify authenticated live account access, deployed price IDs against `billing-catalog.ts`, card-only Checkout, Portal configuration, subscribed webhook events/signing and maintenance HTTP results before activation.

Set Vercel Production `MCA_STRIPE_BILLING_ENABLED=true`, `MCA_STRIPE_MODE=live` and `MCA_TRIAL_REQUIRES_CARD=true` through the controlled release. The existing card-required flag keeps an incompletely configured company in billing setup instead of granting a local no-card trial. Stripe Checkout owns the 14-day trial. Verify the deployed source SHA against the tested release and verify Production database, Auth and Storage all resolve to the production project. Secret existence or redacted environment output does not prove correct values.

Hosted acceptance requires an explicitly designated nonproduction Supabase/Vercel target, synthetic owners with MFA and Stripe test mode. Local database and browser fixtures do not certify hosted readiness. After release, verify both real owners without memberships, empty company/payment views following cleanup, and the next real company's normal signup, ownership, seats, card-backed trial and subsequent signed Stripe records. Do not create a production synthetic company to perform this acceptance.

## One-time operator cleanup

The UUID/name manifest, protected owner IDs and five reviewed local test IDs are fixed in `scripts/ops/platform-fresh-start.ts`. The script cannot accept arbitrary company IDs or a different production project. Its default only inventories public rows and dependent foreign-key records; it creates no persistent schema.

Run from `nextjs-version/` after authenticating Supabase CLI and running `stripe login --project-name 'sentinel tech solutions'` for the reviewed live Stripe account:

```sh
pnpm ops:platform-fresh-start --expected-project-ref=drubsfvhlggmtyiigwxy
```

Apply only after the release prerequisites and the disposable/hosted acceptance checks pass, using an operator-owned directory outside this repository:

```sh
pnpm ops:platform-fresh-start --expected-project-ref=drubsfvhlggmtyiigwxy \
  --apply --confirm --directory=/absolute/private/recovery-directory
```

Directories must be mode 0700; recovery files are 0600. The Supabase Management API token comes from the operator's macOS CLI credential store or `SUPABASE_ACCESS_TOKEN`. The Storage/Auth service key stays in process memory. Neither key is logged. A direct database URL is accepted only with `--synthetic` and a loopback `fundlane_test_*` disposable database; there is no production fallback from synthetic mode.

Preflight stops on an incomplete/changed manifest, any newly created company, unknown membership, protected audit/grant dependency, active retention hold, cross-company dependency, unexpected monetary activity, provider resources requiring separate cleanup, or an active job/delivery lease. It verifies the QA customer `cus_VLVSq1hL2JtKtA` belongs to the reviewed live account/company and has no invoices, subscriptions, charges, balance history, completed Checkouts or uncertain payment intents. Paginated provider history beyond the reviewed limit stops cleanup.

Before deletion it exports public rows, test Auth identities/providers/factors and private object bytes with checksums. It temporarily pauses the two reviewed billing cron jobs, pauses company access, defers queued work and revokes/bans test identities. It expires unused QA Checkouts and deletes the confirmed test-only customer. A database transaction fences writes, checks the exported fingerprint, removes dependent company/test-user rows, and appends stable cleanup audit targets without company foreign keys. Mike and Ben's users, Auth identities, grants, MFA and existing platform audit rows are preserved; their deleted-company memberships are removed.

Storage objects are removed through Storage's API after checking their recovery copies. Confirmed test Auth accounts are removed through Auth's API. External operations are checkpointed separately from the database transaction. On interruption, rerun the exact apply command with the **same directory**. Company access remains paused after a partial failure; the script restores the reviewed cron jobs' original enabled states. Recovery receipts handle a lost response after database commit. Verification rejects remaining company dependencies, objects or test identities. Companies created after the committed reset are excluded from all subsequent cleanup.

## Evidence on 2026-10-01

- Production dry run: exactly six reviewed companies, five reviewed test users and their dependent records; no mutation applied.
- Disposable PostgreSQL: dependency closure (including composite keys), owner/MFA/grant/history preservation, new-company/member/paid-activity/retention/active-job blockers, changed-inventory rejection, forced rollback and repeat execution.
- Synthetic browser: 44 page/theme/viewport checks plus refresh timing, hidden tabs, tab return, manual refresh, draft preservation, filters, pagination and stale/error states.
- Billing/platform tests include signed webhook retries/mode isolation and card-required onboarding with missing Stripe settings. Typecheck/build pass; lint has no errors and 16 pre-existing warnings.
- **Pending:** Stripe CLI reports its live key requires `stripe login`. Vercel returns sensitive environment values as redacted, so Production database/Auth/Storage values and live Stripe configuration are not fully certified. Hosted acceptance, production activation, release, deletion and next-real-company verification remain outstanding.
