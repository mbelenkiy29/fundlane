# Owner portal acceptance scope — October 1, 2026

This change delivers the approved independent slice: shared owner access and navigation, safe read-only company/SMS queues, explicit unavailable monitoring, and a separately reviewed inert SMS credit core. It does not complete the gated SMS commerce/support plan.

## Proven behavior

- Synthetic Mike/Ben-equivalent identities exercise live platform grants, same-session MFA, revoked grants, API-key rejection, legacy/new route guards, session-bound step-up and append-only audit. T1 independent review approved;46 focused tests passed.
- Monitoring tests exercise missing/stale samples and refresh failure without presenting stale successful data as current. Direct-query runtime/job/incident data remains separately visible. T3 independent review approved;5 UI plus24 monitoring/recovery tests passed.
- Queue tests exercise keyset pagination beyond100 rows, filter-before-limit behavior, safe projections, unknown provider observations, authorization, existing financial views and safe default SMS page navigation. The worker recorded33 focused tests passing plus typecheck/scoped lint; browser checks use synthetic component data, not hosted customer sessions.
- Core credit tests exercise immutable purchase/payment/message identities, concurrent reservation admission, once-only settlements/releases, transaction lifetime, same-executor overlapping operations, bounded quantities, cross-company foreign keys and append-only permissions. T6 review initially found a double-debit interleaving; four regressions reproduced it before complete-operation serialization. Re-review approved46 focused tests. No checkout or send endpoint invokes this core yet.

The PR descriptions record final combined commands, outcomes, exact heads and CI status. Task reports preserve detailed red/green evidence; no result here claims hosted provider or production acceptance.

## Remaining launch decisions

Support access consent/duration/scope, provider submission/payment consent, business evidence and retention, number assignment/limits, SMS commercial prices/outcomes/refunds/rentals, alerts and user-support mutations remain at their documented decision gates. Operational projections contain no private document/message/deal payload or decrypted business profile. Existing business review is a separate explicit navigation action.

Authenticated staging Supabase/Vercel checks require an approved nonproduction target and synthetic identities. Twilio eligibility, carrier registration, real numbers, live payments/messages and notification delivery require separate authorization and evidence. This batch performs no hosted migration, grant seeding, production configuration change, merge or manual deployment.

## Schema and rollback

The owner operations slice needs no migration. The separate credit-core PR adds an expand-only schema and message-tenant uniqueness constraint. Migration filename0074 avoids open voice0072/document-notification0073 filenames, but journal ordering still must be refreshed against the actual main history before merge. Run exact-history upgrade and fresh-schema checks after that refresh. Preserve notifications, AI balances, existing SMS records and platform audit/grants.

Keep old URLs guarded during rollback. Retain credit/audit data; a code revert must not refund payments, release numbers, close subaccounts or erase balances. See [release gates](../owner-portal-release.md).
