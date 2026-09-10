# Clerk authentication and company onboarding

MCA uses Clerk for interactive identity, sessions, email verification, password recovery, and Organization invitations. Neon remains authoritative for workspace access, roles, manager hierarchy, seats, and business records. API keys keep their existing MCA scopes and rate limits.

The development application is **MCA** (`app_3J6N3t7eRGSb3u1BO7wUTIEsxyx`, development instance `ins_3J6N3rR8aVEkWzFHk2dbnPV5fV3`). The previous Private AI Cloud and NexExam applications are unchanged. No production Clerk instance, production database migration, or deployment was performed.

## Development setup

Use Node 24+ and pnpm in `nextjs-version/`. The Clerk CLI has written the development publishable and secret keys to `.env.local`. Never commit keys or print environment files.

1. Configure a development Neon database with `DATABASE_URL` and `DATABASE_URL_UNPOOLED`.
2. Apply checked migrations with `pnpm db:migrate`. Migration `0018_clerk_identity` adds unique Clerk identifiers and webhook event receipts without replacing existing IDs.
3. Start `pnpm dev`. Use the existing `/sign-up` and `/sign-in` pages. A new user verifies email, creates/selects an Organization at `/onboarding`, then optionally invites employees using the existing MCA team controls.
4. Existing migrated users choose **Verify email / activate migrated account**, enter the emailed code, and set a new password before access is granted.

Configuration: email/password authentication, verified email, first name enabled, email-code sign-in for migrated accounts, Organizations enabled, automatic domain enrollment disabled. Personal Clerk sessions are allowed only to complete account/company setup; every protected MCA request still requires an active company membership. Clerk's device trust remains enabled. Additional Clerk session tasks are rendered at `/onboarding`.

`CLERK_JWT_KEY` optionally provides Clerk's PEM verification key for networkless JWT verification. `CLERK_API_URL` is supported for protocol fixtures; omit it in normal deployments. Do not substitute the test fixture key for Clerk's production verification key.

## Existing-account migration

Run an inventory first against the explicitly configured database:

```sh
node --conditions=react-server --env-file=.env.local --import tsx scripts/clerk/migrate.ts
```

The default is read-only. It reports counts without emails or password hashes. Review the target database and Clerk instance before applying:

```sh
node --conditions=react-server --env-file=.env.local --import tsx scripts/clerk/migrate.ts --apply
```

The resumable import assigns each user their MCA ID as Clerk `externalId`, records each workspace ID in private Organization metadata, and preserves user/workspace/membership IDs, roles, ownership, and history. Only users with active memberships and active memberships are imported; pending invitations are resent through MCA after cutover. Password hashes and legacy sessions are never imported. Imported users have no Clerk password and cannot enter MCA until they verify email and set one.

Duplicate provider identities or conflicting mappings stop the import instead of linking by email. Retry after reconciliation; already imported records retain their provider IDs. For a production Clerk key, the script additionally requires `--allow-production`. This flag is a release guard, not permission to execute a production migration without reviewing its target.

Before cutover, freeze account/team changes, snapshot the database, migrate and reconcile counts, and verify an owner and employee account. Deploy only after mappings are complete. Old password-login, signup, invitation-acceptance, and recovery HTTP endpoints return 410; `mca_session` is rejected. There is no legacy-auth fallback. Retained session/hash tables are historical data and do not authenticate requests.

## Invitations, revocation, and failure recovery

Only MCA admin/super-admin roles may invite. Clerk members use `org:member`; MCA's four roles stay local, with an informational `mcaRole` mirror. Using Clerk's own dashboard to create a membership does not grant MCA access. An employee needs a locally approved invitation or a migrated active membership.

Seats are reserved transactionally before delivery. If delivery fails, the pending membership retains its seat and the team screen can resend. Delivery finds existing provider invitations by the server-controlled local invitation ID. Resends retain that local ID, revoke pending provider invitations, and reuse an already accepted invitation so acceptance racing a resend remains recoverable. Acceptance checks Clerk's current accepted invitation and membership, then rechecks local approval under a lock before activating the exact pending record. It works before webhook delivery and never revives a deactivated record.

Role changes and deactivation update MCA first. A provider failure can return an error after the local change has taken effect; retrying the same operation reconciles provider state. Local deactivation denies access immediately even if Clerk is unavailable. A deliberately re-invited employee requires a new approved invitation.

Company setup is idempotent by Clerk Organization ID. A provider Organization created before a database failure can be selected again and setup retried. Unknown memberships cannot claim an existing workspace. Clerk email verification marks the company's owner email verified; SMS review, carrier registration, spending limits, and opt-out gates remain enforced separately.

## Webhooks and production activation

Configure `/api/webhooks/clerk` in the appropriate Clerk instance and set `CLERK_WEBHOOK_SIGNING_SECRET`. Subscribe to user and Organization/membership lifecycle events. Missing configuration returns 503; invalid signatures return 400. Successful event IDs are recorded transactionally, and retries/out-of-order events re-read current provider state. Creation events never restore deactivated memberships. Without a live webhook, request-time checks still reject removed/banned users and missing provider memberships; profile synchronization needs webhook delivery.

For production, create the production Clerk instance, configure production domains, auth paths, keys, and the webhook secret, then migrate to that same instance before deployment. Keep the existing business email provider for non-auth business messages. Production migration and deployment are separate release actions.

## Verification

- `pnpm test`: business unit tests mock only the identity gateway; HTTP fixtures use RSA-signed Clerk-shaped JWTs and a local Backend API protocol fixture. Production has no test-user header or legacy-cookie fallback.
- `tests/clerk-auth.test.ts`: stable IDs, four roles, tenant isolation, accepted invitation linking, missing provider membership, deactivation, replay and stale webhook handling, legacy-cookie rejection, and safe return paths.
- `tests/foundation-http.test.mjs`: real Next proxy and route checks for Clerk sessions, retired auth endpoints, invitation resend/acceptance, seat races, admin restrictions, origins, webhook signatures and replays.
- Live migration rehearsal: `node --env-file=.env.local --import tsx tests/helpers/clerk-migration-rehearsal.mjs`. Uses a disposable Neon database and synthetic Clerk users/Organizations, then cleans up.
- Isolated browser server: `node --env-file=.env.local --import tsx tests/helpers/clerk-preview.mjs`. Uses a disposable Neon database and a synthetic Clerk owner. Stop with Ctrl-C for cleanup. Only test emails ending in `+clerk_test` use Clerk's development verification code.

Browser verification completed with the real development instance: existing sign-in UI, email-code verification, owner dashboard, embedded company creation and team setup, invitation delivery, employee acceptance and Rep dashboard, company switching/sign-out, direct team-settings denial, and mobile sign-up layout. Synthetic company creation retained the same user identity and assigned Admin only in the new company. No real employees were invited. Password entry/recovery and every MFA variant still need interactive release acceptance; synthetic credentials were provisioned through Clerk's development Backend API.

### Implementation verification — September 9, 2026

- `pnpm typecheck` and `pnpm build` passed. `pnpm lint` passed with 16 pre-existing warnings and no errors.
- The full `pnpm test` run completed 381 tests: 379 passed and two HTTP fixtures failed. The deals fixture still sent legacy cookies on three raw export requests; the intake fixture inherited useSend configuration instead of testing an unconfigured provider. Both fixtures were corrected and their entire test files passed on targeted reruns. The full 21-minute suite was not repeated after those fixture corrections.
- Final focused Clerk tests passed: six identity/reconciliation tests and six HTTP tests, including passwordless/unverified/banned users, revoked/expired sessions, an acceptance racing a resend, and a simulated Neon failure after provider delivery.
- A real development Clerk import dry-run and two apply passes preserved IDs and roles without importing password hashes. Synthetic browser identities, Organizations, and the preview database were cleaned up.
- Clerk doctor validated the development app, CLI authentication, and keys. It reported production not configured, missing shell completion, and an unreadable existing Codex MCP configuration. Production configuration remains part of release activation.
- Graphify's graph, report, and HTML were refreshed.
