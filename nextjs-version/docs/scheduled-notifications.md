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
