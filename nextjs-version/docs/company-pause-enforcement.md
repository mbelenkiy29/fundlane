# Company pause enforcement

## Live access boundary

`company-access.ts` is the billing-owned source of truth. Business access calls its live database-backed contract; request, worker and dispatch checks do not cache an entitlement decision across operations. Trial/grace expiry therefore does not depend on cron timing. Legacy exemptions are evaluated by that contract.

- `auth.ts` rejects paused session/API-key business requests with `402 company_paused`, after normal identity, role and scope validation. API-key rate accounting is unchanged.
- Explicit `allowPaused` is available to recovery handlers. `requireMembershipAccess(request, roles, { allowPaused: true })` preserves the session and role checks. API keys cannot use this exemption.
- Existing billing recovery API paths are an exact allowlist: `/api/billing`, `/api/billing/checkout`, `/api/billing/portal`, `/api/billing/sync`, for admin/super-admin sessions only. Billing handlers remain responsible for owner authorization. Newly added billing recovery routes must opt in explicitly.
- `/api/auth/session` remains usable for session recovery/navigation. The dashboard layout replaces paused business pages with a small recovery screen. `/settings/billing` remains reachable by administrators; sign-in, onboarding, password recovery, account-security and sign-out are outside this dashboard gate.

## Worker and dispatch coverage

| Path | Enforcement |
| --- | --- |
| Durable background jobs | Claims exclude paused companies before incrementing attempts. Dispatch and reconstructed system/user/API-key actors check again. A pause discovered after claim releases processing work with its attempt restored. |
| Submission email, funder API, custom webhook and closing delivery | Live checks at job entry and dispatch; email package preparation and adapter credential loading are followed by another check. Pause failures halt the outbound request rather than spending retry budget. |
| SMS | Closing/direct SMS uses the shared dispatch gate after credential/callback preparation. Provisioning checks before claim and each provider call; interrupted paid operations require review. |
| Email conversations | Sender candidates are checked before leases; member/deal/recipient permissions and company access are checked after OAuth refresh and again at provider request dispatch. |
| Intake | Authenticated applications/emails retain their source without creating a deal or running extraction while paused. Attachment claims and processing stages are gated; a pause does not spend an attachment retry. Document AI, statement extraction and criteria scans check before provider work. |
| Follow-ups, digests, workflow webhooks | Due follow-up/digest occurrences observed during pause are skipped. Workflow outbox rows are halted and require explicit replay. Dispatch is checked again. |
| Invitation outreach | Invitation deliveries are gated. Due reminder identities observed during pause are halted without incrementing successful reminder counts. Reminder delivery rechecks invitation state, cadence and freshness. |
| Calendar | Paused connections are deferred without consuming failure counts; every Google Calendar request checks access, including after OAuth refresh. Expired historical activities are not newly exported. |
| Assistant | Delegated ChatKit/native contexts check company access. The existing conversational assistant's live authorization guard reaches the common API gateway before model/tool operations. |

Provider-independent transport utilities are not standalone authorization gateways. Production callers must use the workspace-aware service boundary.

## Receipts and recovery

Stripe billing notifications/webhooks and authentication recovery remain operational. SMS delivery receipts, inbound SMS and opt-out evidence remain accepted. Calendar push notifications only schedule later reconciliation.

Authenticated funder status and PSF/DocuSeal completion callbacks received during pause are deduplicated into `audit_events` with action `company.paused_receipt`; payloads are encrypted with the workspace key. They do not advance offers, funding or signature state. Recovery requires an explicit provider redelivery/current-status refresh. Preserved receipts are not automatically replayed as business commands.

Queued outbound work **observed during a pause** is not automatically released:

- Background submission/invitation sends become failed with `company_paused`; ordinary non-outbound jobs can resume with current authority checks.
- Queued/blocked conversation messages become failed without a send attempt. An explicit user retry/new message rechecks the current recipient and permissions. Sending/unknown provider identities are preserved for reconciliation and never blindly resent.
- Due follow-up/digest occurrence identities remain skipped. Outbound intake acknowledgement emails observed during pause retain `company_paused_review_required` and are excluded from automatic delivery; send a newly reviewed message if contact is still needed.
- Durable outbound approvals older than 24 hours require review; invitation reminders more than 24 hours past their scheduled cadence are skipped. Existing idempotency identities and uncertain-delivery fences are preserved.

The billing-owned monotonic `last_paused_at` boundary now invalidates approvals even when pause and recovery both happen while workers are offline. `assertCompanyOutboundAllowed(workspaceId, approvedAt)` rejects approvals at or before that boundary with `company_outbound_reapproval_required`. Billing lifecycle tests verify manual recovery, expired trial conversion, and expired grace recovery; healthy reconciliation does not move the boundary.

`outbound-approval.ts` carries the original approval through asynchronous delivery conversion. Creating a new closing/SMS delivery row does not renew its parent preview/job approval. Dispatch checks use job creation, closing/PSF preview creation, email creation or explicit retry audit time, provisioning operation creation, webhook outbox creation, scheduled follow-up/digest time, invitation job creation, and intake receipt creation. Existing 24-hour freshness guards remain additional bounds. Email retry audit events are written in the same transaction as requeueing and retain message/request/provider idempotency identities. Explicit webhook replay supplies a new reviewed timestamp; automatic retry retains the original timestamp.

Remaining boundaries: calendar synchronization retains its live access and expired-activity checks; it is current-state reconciliation and has not been converted to a durable approval/review workflow. Read-only provider reconciliation and processing jobs resume using current authority. An external request already dispatched cannot be recalled, and database checks cannot atomically encompass a remote provider accepting a request. Provider-independent transports still depend on workspace-aware callers.

## Verification

Pause-specific tests cover session/API-key gates and exact recovery paths, inactive membership/role enforcement, paused queue claims and attempt preservation, retained intake, blocked delegated/provider dispatch, outbound freshness, paused messaging recovery, pause during OAuth refresh, skipped follow-ups, and deduplicated DocuSeal receipt retention. Offline-recovery tests additionally verify stale dispatch rejection, preservation of the original approval across a transaction, and successful explicitly reviewed email retry with stable idempotency. Existing worker, intake, communication, submission, provisioning and closing suites exercise their original concurrency/idempotency behavior. Verification for this integration passed 162 tests (35 pause/email/DocuSeal, 107 integration regressions, 20 billing lifecycle), TypeScript, and lint (17 warnings, no errors).

Use a disposable local PostgreSQL database via `MCA_TEST_DATABASE_ADMIN_URL`; never run these fixtures against the application database.
