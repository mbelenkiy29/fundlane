# Company billing (development only)

Clerk owns company plans/subscriptions and processes test payments through its development Stripe gateway. Neon owns MCA membership, roles, invitation reservations, business data, and the effective seat allowance. Billing never gates deal access, business review, SMS approval, or historical records. No card information is stored in Neon.

## Catalog and configuration

| Clerk slug | Monthly company price | Total local active + pending seats |
| --- | --- | --- |
| `free_org` | $0 | 1 |
| `mca_starter_test` | $49 | 5 |
| `mca_team_test` | $99 | 20 |

Prices are fixed for the whole organization, including the owner. No per-seat charge, annual price, or trial is configured. Development app: `app_3J6N3t7eRGSb3u1BO7wUTIEsxyx`, instance `ins_3J6N3rR8aVEkWzFHk2dbnPV5fV3`. Both paid seat caps were saved and verified in Clerk Dashboard; the Free default organization limit is one.

Run from `nextjs-version/` using the authenticated Clerk CLI:

```sh
node scripts/clerk/setup-billing.mjs
node scripts/clerk/setup-billing.mjs --apply
```

The script defaults to dry-run, targets this development app explicitly, and reconciles catalog entries by slug and roles by key. Clerk CLI 3.3.0 does not expose plan seat caps in its configuration schema: after first creation, set Starter Test to **Seat-based / Custom limit 5** and Team Test to **Seat-based / Custom limit 20**, with per-seat fees off, in Dashboard → Billing → Subscription plans → Plans for Organizations. Re-running the catalog patch preserves these settings.

Set `MCA_CLERK_BILLING_ENABLED=true` alongside development Clerk keys. The example environment defaults to false. Apply additive migration `0019_workspace_billing.sql` using `pnpm db:migrate` against the intended isolated development database. This implementation was validated on disposable isolated Neon databases; it does not apply a production schema migration.

## Authorization and synchronization

Only active local `admin` and `super_admin` memberships receive `org:mca_billing_admin`, with exactly `org:sys_billing:read` and `org:sys_billing:manage`. Local managers/reps receive `org:mca_employee`, with no permissions. Default Clerk member billing permissions are removed. The billing role has no organization member-management permissions. Invitations always use the employee provider role until synchronous acceptance reconciles the authorized MCA role.

The embedded UI exposes pricing, checkout, subscription changes, statements, payments, and payment methods. The optional onboarding plan step is available to owners/admins; invited employees go directly into their company. `/settings/billing`, `GET /api/billing`, and `POST /api/billing/sync` require a local active administrator and valid remote membership; API keys do not grant billing access. JSON errors use 401/403 for authentication/authorization, 409 for cap/payment conflicts, and retryable 503 for unavailable billing verification.

`workspace_billing` contains subscription/plan identifiers, status, effective dates, seat limit, payment-past-due flag, and sync timestamp. `workspaces.seat_limit` is updated atomically with this snapshot. Manual changes to a managed seat limit are rejected. Active and pending memberships count toward capacity; expired invitations retain their reservation. Resends reuse the existing reservation.

Configure Clerk's signed endpoint `/api/webhooks/clerk` with `CLERK_WEBHOOK_SIGNING_SECRET`, subscribing to all `subscription.*`, `subscriptionItem.*`, and `paymentAttempt.*` events as well as the identity events in [Clerk authentication](clerk-auth.md). Events are invalidation hints: the handler re-reads current Clerk state, locks the workspace, and records the event ID in the same database transaction. Duplicate IDs are ignored; out-of-order delivery cannot restore an old plan. Failed processing returns 503 without recording completion so Clerk can retry.

Checkout return and subscription changes trigger `/api/billing/sync`. Invitation reservation and delivery each verify current billing under the workspace transaction lock. Thus checkout and new seats do not depend on webhook delivery, and concurrent invitations cannot exceed the cap. A canceled paid item keeps its limit through `periodEnd`; past-due subscriptions block invitations. Upcoming/incomplete items never grant new seats. Once a lower plan becomes effective, over-cap companies keep their employees/data and must free capacity or upgrade before inviting. Provider outages retain existing application access and the last persisted billing snapshot; new invitations require successful verification.

For existing mapped companies, reconciliation defaults to dry-run and can be resumed:

```sh
node --conditions=react-server --env-file=.env.local --import tsx scripts/clerk/reconcile-billing.ts
node --conditions=react-server --env-file=.env.local --import tsx scripts/clerk/reconcile-billing.ts --apply
```

Run against an isolated development database first. It reconciles active roles, removes deactivated provider memberships, and refreshes each mapped company's billing. A failed company is reported by local ID and can be retried without changing local identity IDs. Team role/deactivation mutations report provider errors; retry them or run reconciliation to finish provider cleanup. Existing authentication migration also assigns these roles when billing is enabled and preserves imported team size while creating provider organizations.

## Verification

`tests/billing.test.ts` exercises effective plan selection, paid cancellation periods, incomplete/unknown plans, payment failures, outages, replay/out-of-order events, transactional rollback/retry, and manual seat bypass protection. `tests/billing-http.test.mjs` uses an isolated Neon database and a local Clerk protocol fixture with genuine RSA-signed session tokens to test authorization, simultaneous reservations, resend reuse, over-cap preservation, billing outages, invalid signatures, duplicate webhook delivery, same-identity company switching, all four local roles, and immediate deactivation. Existing foundation/API-key tests remain part of `pnpm test`.

A real development Clerk/Stripe checkout was completed using the built-in test card for Starter Test. Neon and the team page changed from one to five seats before webhook delivery; a synthetic employee invitation then reserved the second seat. End-of-period cancellation showed paid access through October 9 while Neon retained five seats. Billing was inspected at desktop and 390px mobile widths. Test fixtures use disposable identities and databases.

Clerk's experimental billing UI/backend packages are pinned in `package.json`; update them deliberately and repeat checkout/cancellation tests. Webhooks need a reachable development endpoint to test external delivery; local verification uses signed protocol events plus synchronous real-provider checkout reconciliation.

## Separate production release

Production remains disabled and requires a separate reviewed release: connect the production Stripe account in Clerk, approve real prices and matching seat mappings, apply the additive Neon migration, configure production signed webhooks, reconcile existing company roles/subscriptions, and validate checkout, renewal, decline/recovery, cancellation, company switching, and rollback in staging. Do not enable this test catalog in production. Existing company accounts/data must not be removed when rolling billing forward or back.

Tax/VAT is a live-activation blocker: the supplied Clerk Billing documentation states it is unsupported. Resolve tax collection and invoicing requirements against current Clerk capabilities before accepting live payments.

References: [Clerk B2B Billing](https://clerk.com/docs/nextjs/guides/billing/for-b2b), [Billing webhooks](https://clerk.com/docs/nextjs/guides/development/webhooks/billing). Clerk manages plans; Stripe is the payment processor, so separate Stripe Billing products are not needed.

### September 9, 2026 verification result

- `pnpm test`: 391 passed, zero failed/skipped (full integration suite).
- Final billing HTTP rerun after the pending-role fix: 4 passed; billing service tests: 6 passed in the full run.
- `pnpm typecheck` and `pnpm build`: passed.
- `pnpm lint`: zero errors, 16 pre-existing warnings; the changed billing files have no lint warnings.
- Clerk doctor verified the linked development instance and credentials. Existing warnings remain for absent production configuration, shell completion, and an unreadable Codex MCP configuration.
- `graphify update .` and `graphify cluster-only . --no-label`: completed; report and HTML refreshed with the increased visualization node limit.
- Synthetic checkout owner/organization and isolated preview database cleaned up. No production database migration, deployment, Stripe connection, or live payment was performed.
