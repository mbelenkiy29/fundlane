# Shared scheduled notifications

Foundation for document, renewal and internal missed-call events. Producers call the server-only API; they do not send mail/text themselves. Default runtime is inert. The existing `/api/cron/comms` tick consumes notifications only with `MCA_NOTIFICATION_RUNTIME=enabled`. No schedule or provider configuration is installed by this PR. The notification budget is measured from the original comms tick start; exhausted ticks leave events queued, with room reserved for bounded provider calls.

## Producer contract

```ts
import {enqueueNotification} from '@/lib/mca/notifications/service'
import {liveEmailActor} from '@/lib/mca/email-conversations/service'

const actor = await liveEmailActor(workspaceId, originatingMembershipId)
await enqueueNotification(actor, {
  eventKey: `documents:${requestId}:${occurrenceDate}`,
  kind: 'document', // document | renewal | missed_call
  dealId,
  audience: 'broker',
  channel: 'email',
  recipientUserId: assignedBrokerUserId,
  scheduledFor: dueAtIso,
  approvedAt: originalApprovalIso,
  payload: {title: 'Documents due', message: 'Review the requested documents.'},
}, {executor}) // optional DbExecutor: insert rolls back with producer transaction
```

`actor.workspaceId` is the tenant authority. `liveEmailActor` validates active membership/role; references and broker deal visibility resolve inside that company. No caller-supplied email/phone is accepted. A broker alert may omit `dealId` for company events such as missed calls. Keep payload summaries tenant-local, concise and free of sensitive document contents, provider credentials or third-party identifiers. Each intended broker receives a separate event identity. Use a stable eventKey, audience, channel and recipient; changing input for an existing identity rejects with `notification_idempotency_conflict`. UTC ISO values normalize through Zod; enqueue rejects future approval.

Merchant input requires `dealId`, `templateId` (published merchant/followup/request_info template), and `senderId` for email; omit broker payload/recipientUserId. Explicit per-kind company policy and applicable consent are required. `setNotificationPolicy` is company-admin only, defaults broker on/merchant off. `setNotificationConsent` records explicit email notification consent for the current deal contact; SMS uses existing `recordSmsConsent` and provider opt-out. `suppressNotificationRecipient` and unsubscribe override policy and consent. Contact changes require a new approved event. Stored approval is never renewed by the worker; merchant sends use `withOutboundApproval`. Broker alerts check company operational status but do not use merchant-send approval. Staff SMS is blocked until an approved staff-consent transport exists.

Optional `condition:{type,key,version?}` is checked at enqueue and dispatch through `registerNotificationCondition` in `notifications/conditions.ts`. Guards resolve their key inside actor.workspaceId and return boolean or `{eligible,templateValues?:{document_request_url?,document_request_label?}}`; these fixed values must come from persisted server link state. Unregistered/resolved conditions suppress sending. Registration must run in both the producer and cron process. Document-task renderer/registration bootstrap is a pinned dependency; this foundation cannot publish unknown template variables or assume process-local registration carries between requests.

The optional producer executor operates within the existing transaction context. Do not hold a producer transaction open around provider calls. A producer must choose an active originating membership with current deal visibility; a stale member is suppressed at dispatch, rather than silently impersonating an administrator.

## Delivery and receipts

The outbox claims one due row with `FOR UPDATE SKIP LOCKED`, increments attempts, and commits its sending marker/token before provider work. Live member/deal/recipient, company policy, published template, consent, suppression and original approval are rechecked. Recipient/content are encrypted with tenant AAD. First dispatch freezes body and recipient; retry rechecks current eligibility but preserves original content/idempotency key.

`NotificationTransport` returns accepted, delivered, retry, failed or uncertain. Default merchant email uses existing `Mailbox.connect/send/findSent` (verified Google/Microsoft merchant sender). Merchant SMS delegates to `deliverClosingSms`, preserving its number/consent/usage/idempotency ledger. Broker email uses existing system-email provider with a stable key and provider ID. It does not require generic email webhook configuration. Missing provider configuration fails visibly; preview never counts as sent.

Only proven rejection may retry (three attempts, 15/30-minute backoff). Unknown sends, network failures and expired sending markers stay uncertain and are never automatically resent. Receipts are appended in the same transaction as token-fenced state updates. Accepted means provider acceptance, not delivered/read. A bounded, token-free receipt poll rotates due rows with a 15-minute next-check marker to avoid starvation and duplicate lookups. It reads SMS status callbacks and merchant Sent mail; absent records do not authorize replay. System broker receipts require operator review. `reconcileNotification(admin,id,{outcome:'accepted'|'delivered'|'failed',evidence})` records a provider-console reference/review and resolves uncertainty without requeue. Never paste secrets or message bodies into evidence.

Opaque recipient-specific unsubscribe capabilities appear in each message. GET only displays confirmation; POST suppresses this company/address/channel, including future events. Tokens expose no workspace or deal IDs. Consent updates do not clear suppression. Restoration requires separately reviewed product UX; this foundation intentionally has no silent resubscribe behavior.

## Migration, runtime and release gates

Migration `0071_notification_foundation`, journal idx62/version7/when1790385600020 (after applied `0070` idx61/when1790385600019): four tables (event outbox, policy, recipient preferences combining consent/suppression, append-only receipts); adds tenant composite unique deal index for a tenant-safe FK. The existing followup, submission and conversation queues retain their behavior and ownership. A generic event lifecycle cannot fit their constrained domain identities without conflating policies.

`0071` builds the unique index on `deals(workspace_id,id)` inside the migration transaction, so apply it with a lock timeout (for example, `SET lock_timeout = '5s'`).

Apply checked migrations and restricted role grants through the existing human-reviewed release flow. Never use hosted migration as build/setup. Enable runtime only after synthetic nonproduction provider tests, sender scopes/number readiness, existing comms scheduler ownership and restricted role validation. Verify company pause/reapproval, opt-out between enqueue/send, disconnect, callback receipts, killed send, duplicate events and bounded cron duration with the deployed head. No new cron is declared in `vercel.json`; do not create a second consumer/schedule. Disable `MCA_NOTIFICATION_RUNTIME` to stop dispatch without deleting pending/uncertain rows.

Local proof uses disposable PostgreSQL and mocked transports. It does not prove hosted credentials, provider delivery, unsubscribe email rendering, number provisioning, A2P approval, Vercel scheduler ownership or preview environment isolation. No live sends, provider provisioning, production data or security settings were used.

Claim leases use fresh operation time inside each claim transaction. A tick shares one deadline across reconciliation and dispatch. Receipt lookups pass this deadline into the mailbox heartbeat, which requires enough time for the existing15-second provider request before every page or refresh. The default delivery adapter invokes a worker-supplied live eligibility callback after connect and immediately before provider IO, so consent, recipient/access, approval and registered conditions are rechecked after OAuth awaits. A refused pre-send check suppresses the row; a deadline refusal before IO is safely bounded by the normal retry limit. Network outcomes remain uncertain and are never replayed automatically.

## Renewal alerts

With `MCA_RENEWAL_ALERTS_ENABLED=true` (default off; only `"true"` enables), each `/api/cron/comms` tick runs `runRenewalEligibility` with a system actor for every company that has a renewal policy, then enqueues a broker email `renewal` notification to each active assigned originator/closer. Event key `renewal:v{policyVersion}:{advanceId}` makes reruns idempotent; a new policy version re-alerts. At dispatch the alert is suppressed unless the action is still eligible under the current policy and its advance is not reversed. Companies without a policy are never selected; per-company errors are counted and do not fail the tick. Delivery still requires `MCA_NOTIFICATION_RUNTIME=enabled`. Merchant reminders are not sent.

### Turning renewal alerts on in production

Renewal alert emails go to brokers through the system email provider (Resend, or useSend as the fallback). They never use a company's connected mailbox, and merchants never receive them. **Infrastructure is the single owner** of this rollout and of the `/api/cron/comms` schedule. Nobody else should install the schedule or flip these flags.

**Scheduling `/api/cron/comms` does more than renewal alerts.** Every tick also:

- sends due daily report emails (enabled `mca_digest_subscriptions`);
- retries pending workflow webhooks (`mca_workflow_webhook_outbox`);
- sends onboarding emails, when `MCA_ONBOARDING_EMAIL_ENABLED=true` with the enrollment runtime on;
- ingests funder replies, when both reply-ingest flags are on.

With `MCA_NOTIFICATION_RUNTIME=enabled`, every queued notification goes out too, not only renewal alerts.

**Pre-check before installing the schedule.** Run against production and review anything unexpected before the first tick:

```sql
-- Workflow webhooks that will be retried (max 5 attempts)
SELECT workspace_id, count(*) FROM mca_workflow_webhook_outbox WHERE state = 'pending' AND attempts < 5 GROUP BY 1;
-- Daily report subscriptions that will start sending
SELECT workspace_id, count(*) FROM mca_digest_subscriptions WHERE enabled = 1 GROUP BY 1;
-- Notifications that will be dispatched once MCA_NOTIFICATION_RUNTIME=enabled
SELECT kind, state, count(*) FROM mca_notifications WHERE state IN ('queued','retry') GROUP BY 1, 2;
```

**Order** (each step only after the previous one is confirmed):

1. **Migrations:** `0008` (renewal policies and actions) and `0071` (notification foundation) are applied.
2. **Environment, then redeploy:**
   - `MCA_APP_ORIGIN` is the public `https://` app origin. Every alert carries an unsubscribe link built from it. A missing or non-https origin suppresses each alert with `notification_origin_invalid`.
   - System email is configured: `MCA_SYSTEM_EMAIL_PROVIDER=resend`, `MCA_RESEND_API_KEY` and `MCA_RESEND_FROM`, or the useSend equivalents.
   - `CRON_SECRET` is set.
3. **Schedule:** `/api/cron/comms` runs every five minutes with `Authorization: Bearer ${CRON_SECRET}` (see `docs/ops/cron-schedules.json`), after the pre-check above.
4. **Policies:** each company that wants alerts saves a renewal policy on the **Renewals** page (`/renewals`): paid-in threshold and minimum days since funding. Companies without a policy are skipped.
5. **`MCA_RENEWAL_ALERTS_ENABLED=true`** (redeploy). Each tick now finds eligible advances and queues alerts.
6. **`MCA_NOTIFICATION_RUNTIME=enabled`** (redeploy), last. Queued alerts, and any other queued notifications, start sending.

**Expect a first burst.** The first tick after step 5 alerts every advance that is *already* eligible, not only new ones. Saving any new policy version re-alerts every advance that is still eligible, because the event key includes the policy version. Change policies deliberately.

**Rollback:** unset `MCA_NOTIFICATION_RUNTIME` (stops all sending) and `MCA_RENEWAL_ALERTS_ENABLED` (stops new alerts), then redeploy. Remove the schedule if the other comms jobs must stop too. Queued rows are kept for review.

Staging verification on 2026-10-03 (Supabase `djnhfcxbuigsnqwcpdrz`, synthetic "Staging Drill Co", main `6c4bcac`, stub transport so nothing was sent):

- Policy v1 at 90% paid-in: the first tick queued 23 alerts across 80 advances. The second tick queued 0.
- Dispatch with no https `MCA_APP_ORIGIN`: all 23 were suppressed with `notification_origin_invalid`. This led to item 3 above.
- Policy v2 with an https origin: the tick queued 23 new alerts, and dispatch accepted 23. The pre-send live check ran for each one. A second dispatch pass and a further tick did nothing.
- Not covered: real provider delivery and the hosted cron schedule.
