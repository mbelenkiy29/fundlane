# Pending invitation profile isolation audit — 2026-10-01

Reviewed starting commit `e592bb77967cb98746f43824b24d8882584ed583`. Its team list/detail projection correctly hides a pending shared user's global name and phone. Its tests covered existing accounts and two-company placeholders, but not each login signal independently, active-member visibility, or ordering. Team ordering still used the hidden global name; this audit changes it to the displayed name.

A shared pending profile means `m.status = 'pending'` and any of: non-null `supabase_user_id`, non-null `password_hash`, or another membership for that user. `src/lib/mca/membership-profile.ts` supplies static SQL expressions for aliases `m` and `u`: email as name, null as phone. Fresh single-company invitation placeholders and non-pending memberships retain existing behavior.

A deactivated member can be re-invited using the same membership ID. Historical assignments, distributions, application invitations, and submission jobs therefore need the rule too, even when creating those records originally required active membership. No migration is required.

## Search and verdicts

Used Graphify followed by whole-repository `rg` searches for users/memberships joins, qualified name/phone selections, derived display names, and callers including `src/app/api`. Paths below are relative to `src/lib/mca` unless otherwise specified. The Vite/template code and operational seed/verification scripts do not provide workspace server profile responses.

| Path | Verdict and reason |
| --- | --- |
| `memberships.ts` list/detail/update response; `/api/memberships` | Safe projection from HEAD; fixed hidden-name ordering; extracted shared expressions. |
| `applications/report.ts` | Leak fixed: employee roster and performance rows included pending shared names. |
| `applications/service.ts` | Leak fixed: historical client invitation list/detail employee names. |
| `reports/rep-funnel.ts` | Leak fixed: assigned representative names. |
| `reports/team-profit.ts` | Leak fixed: employee/manager names. |
| `intake/service.ts` | Leak fixed: assigned names on intake summaries. |
| `submissions/dashboard.ts` | Leak fixed: submission representative names. |
| `submissions/portal.ts` | Leak fixed: operator display names; now resolves the creator through the job's workspace membership. |
| `exports/query.ts` | Leak fixed: `all_deals_owners` primary originator name. Other export kinds return membership IDs or merchant/owner data, not account profiles. |
| `advances/repository.ts` | Leak fixed: assigned-team aggregation in list and detail. |
| `deals/book.ts` | Leak fixed: assigned-team aggregation and primary originator in book list/detail/filtering. |
| `accounting/repository.ts` | Leak fixed: distribution recipient names. |
| `accounting/schedules.ts` | Leak fixed: installment recipient names/order in list, exception, payment and already-paid retry responses, using both selectors. |
| Team/assignee/SMS/sender/payment/report pickers using `/api/memberships` | Safe: protected projection; many additionally filter to active members. |
| `calendar/service.ts`, `closing/service.ts` | Safe: direct name queries restrict membership to active. |
| `src/app/api/mca/assistant/credits/admin/route.ts` | Safe: direct API name query restricts membership to active. |
| `submissions/email-templates.ts` | Safe: representative lookup restricts membership to active. |
| `assistant/alerts.ts`, `assistant/chatkit-context.ts` | Safe: active workspace membership required. |
| `comms/templates.ts`, `underwriting/review-mail.ts` | Safe: use protected `listMemberships`. |
| `imports/service.ts`, `intake/configuration.ts`, `intake/native-apply.ts` | Safe: use protected membership helpers; active-membership checks additionally restrict applicable flows. |
| `applications/reminders.ts` | Safe: both scheduling and dispatch require `invitationActive`, which rejects pending memberships before using employee names. |
| `comms/digest.ts` | Safe: delivery rejects non-active subscriptions/memberships before using profile fields; no workspace roster response. |
| `sessions.ts`, `supabase-auth.ts` | Safe: authenticated user's own profile, active workspace membership. |
| `memberships.ts` invitation/create/resend/revoke/recovery; `supabase-team.ts` | Safe: invitation metadata/email only; membership mutation responses use protected detail. |
| `db.ts`, `deals/repository.ts`, `home/service.ts`, audit/activity consumers | Safe: actor IDs and workspace record summaries; no global profile hydration. |
| `sms/onboarding.ts`, `sms/managed.ts`, SMS/voice services | Safe: company/submitted contact data, managed phone numbers, email/IDs; no global user name/phone roster. |
| `notifications/service.ts`, `billing-operations.ts`, `trial-abuse.ts`, `jobs/queue.ts`, `totp-service.ts`, `company-ownership.ts`, `workspaces.ts` | Safe for this issue: identity/email/ownership checks, IDs, active membership checks, or account creation; no pending profile response. |
| `platform-console.ts` company owner/candidate/member views | Intentional cross-company: platform-admin authorization, unchanged. |
| `platform-auth.ts` SMS approver authorization; `platform-queues.ts`; platform/owner audit views | Intentional cross-company operations, unchanged; approver ceiling is an email allowlist, not a workspace profile roster. |

The affected `/api/mca` report, intake, application, submission, portal, advance, book, accounting and export routes delegate to the fixed services. No other direct API profile query was found beyond the active-only assistant credit list.

## Verification

Node 24; disposable PostgreSQL supplied by `MCA_TEST_DATABASE_ADMIN_URL`. Ran the package test command's flags with only these eight files (106 distinct tests passing across the targeted runs; no skipped tests):

- `tests/invitation-profile-isolation.test.ts`
- `tests/application-outreach.test.ts`
- `tests/deals-book-db.test.ts`
- `tests/intake-workflow.test.ts`
- `tests/milestone05-accounting-db.test.ts`
- `tests/milestone05-schedules.test.ts`
- `tests/milestone06-team-profit.test.ts`
- `tests/submissions-portal.test.ts`

Shared test support: `tests/helpers/pending-profile.ts`. Each query regression first verifies the synthetic private name is actually present while active, then verifies the pending result includes the email and excludes the private name. The invitation tests independently exercise all three sharing signals, visible-name ordering, fresh placeholders, phone masking, and active-member profile visibility.

`pnpm typecheck` passed. `pnpm lint` passed with 16 existing warnings and no errors. The initial new ordinary-deals export assertion was corrected because that export contains membership IDs, not names. The schedule fixture's argument type was corrected. All affected tests passed on rerun.

No full-suite run, hosted acceptance, external delivery, migration, push, GitHub action, environment-file edit, or provider-setting change.
