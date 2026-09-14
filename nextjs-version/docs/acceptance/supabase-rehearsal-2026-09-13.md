# Isolated migration rehearsal — 2026-09-13

**Result: partial pass; end-to-end release acceptance remains blocked.** No production, domains, provider settings, live records, or deployments were changed. No email was sent. Only newly generated synthetic staging identities, workspace fixtures, and exact storage object keys were created/deleted; unrelated existing objects were retained.

## Target and reproducibility

- Supabase: `drubsfvhlggmtyiigwxy` (`fundlane-staging`), confirmed by the migration runbook and guarded staging credentials. Verified TLS remained enabled.
- Vercel: `https://fundlane-staging-michael-belenkiys-projects.vercel.app`; GET `/api/auth/session` returned 302 to `vercel.com` without following the redirect. Deployment protection prevents unauthenticated hosted acceptance.
- Code: commit `6224fa3`, detached worktree `/private/tmp/mca-migration-rehearsal-20260913`. The user's checkout changed from `main` to `ft-home-dashboard` during inspection and had an in-progress conflict in schema/journal files; it was left untouched.
- Live Linear search found no Supabase migration issue; the linked navigation document still describes Neon. The migration runbooks at the tested commit supplied the staging contract.
- Installed the frozen lockfile in the isolated worktree with lifecycle scripts disabled. No production environment file was loaded. The Supabase connector denied its read-only query; explicitly guarded local staging database credentials worked.

## Fresh evidence

| Area | Result |
| --- | --- |
| Schema/security metadata | 171 public tables, all 171 with RLS; no direct table grants to `anon`/`authenticated`; zero unvalidated public foreign keys. Hosted migration count 29 matches local journal count 29. Supabase user mapping, session revocations, upload and background-job tables exist. This is metadata verification, not full schema/checksum or transfer parity. |
| Real staging Auth via local Next server | 9 checks pass: password sign-in and SSR cookies/company selection; forged company denial; immediate role change; password reset with other-session revocation; one-time invitation acceptance with assigned role; immediate deactivation with other-company access retained; logout token replay denial; recovery callback/migration gate; signup verification/company creation. Synthetic fixture cleanup completed without reported errors. |
| Invitation fixture fix | Saved helper used legacy `hashOpaqueToken`; current app requires `hashSupabaseInvitationToken`. Corrected only the rehearsal helper and added staging database guards plus disabled local background work. Rerun passed. The application auth policy was not weakened. |
| Private storage | Required buckets are private. A unique 5 MiB synthetic object round-tripped through application storage, duplicate upload was denied, and public URLs were denied. Exact synthetic key removed from quarantine and clean buckets. |
| Native processing | Installed ClamAV 1.5.4 failed closed with exit 2: no signature database at `/opt/homebrew/var/lib/clamav`. No clean promotion was attempted. Native clean/EICAR and full worker processing remain unverified. |
| Maintenance tests | `node --experimental-test-module-mocks --conditions=react-server --import tsx --test tests/maintenance-capture.test.ts`: 9/9 pass, including 503 gating, immutable encryption, chunk integrity, manifest-last durability, failed writes, receipt clocks and replay allowlists. Storage is mocked in this suite. |
| Hosted maintenance capture | Synthetic 35 MiB request recovered byte-for-byte with matching SHA-256; four ciphertext parts, largest 20,971,520 bytes, then manifest. All 5 synthetic objects removed. |
| Hosted capture/replay | Original valid Stripe signature returned 200; invalid signature returned 400; encrypted processed receipt persisted. All 3 synthetic objects removed. Uses an unmapped synthetic customer: proves signature/replay mechanics, not business reconciliation or payment delivery. |
| Static/build checks | `pnpm typecheck` passed. `pnpm lint` failed: 3 existing `react-hooks/refs` errors in `duplicate-merchant-dialog.tsx`, 16 warnings. `pnpm build` failed with ENOSPC writing `.next/trace`; build is not verified. |

The corrected repeatable Auth helper is `.migration/verify-stage-auth-rehearsal-20260913.ts` in the original checkout; execute only with the tested migration code and staging environment, not the current conflicted checkout. Worktree artifacts are in `nextjs-version/.migration/`, including `auth-staging-verification.json` and `rehearsal-build.log`. No source database dump or historical production rehearsal artifacts were replayed. Full database suites were not run: their helper creates/drops databases on a separately designated disposable cluster, outside the sole staging target authorized here.

## Remaining gates and rollback boundaries

1. Identify existing designated Render staging processing, ingress, assistant-maintenance and HTTPS gateway service IDs/URLs. No target was supplied in the saved staging environment. Verify their deployed revision, staging-only credentials, scanner signatures/disk, leases/retries/fencing, native clean/EICAR processing, ingress size handling, and signed Vercel↔Render callbacks. The global worker claim function can claim any available job; it was not started against unrelated staging jobs.
2. Obtain authenticated access to the protected Vercel staging preview for hosted auth/upload/workflow acceptance without disabling protection or changing configuration.
3. Complete invitation resend/revoke and wrong-account/expired-link acceptance coverage with a synthetic delivery sink; this run covered acceptance/reuse and deactivation only. Production SMTP/provider callbacks and historical Clerk identity reconciliation remain separate release gates from the runbook, not freshly verified provider facts.
4. Rehearse synthetic source-to-target snapshot/restore and data/ciphertext/file parity in a separately approved empty target. Existing staging application tables were preserved; no import, schema reset, source reads or production snapshots were used.
5. Before target writes reopen, rollback requires the original Neon/Clerk binary/configuration plus retained capture objects and a separately tested source-compatible replay path. The full Supabase release is not a compatible Neon replay implementation. Source drain, origin transition and rollback execution were not performed.
6. After target writes begin, fix forward or reconcile a reverse transfer; never reconnect to stale Neon. This boundary was reviewed against `maintenance-cutover.md` and `supabase-vercel-migration.md`, not demonstrated through a production switch.
7. Resolve unrelated lint errors and host disk capacity, then rerun build and remaining acceptance checks on the chosen release revision. Retain all existing production providers, domains and activation states throughout the rehearsal.

## Local build follow-up

The current Fundlane working tree now passes lint (0 errors, 16 warnings), typecheck and production build after the dialog/helper lint fixes and removal of inspected generated Next.js outputs. See [local release-check evidence](release-checks-2026-09-13.md). This supersedes the local lint/disk blocker only; it does not rerun or clear the hosted acceptance gates above.
