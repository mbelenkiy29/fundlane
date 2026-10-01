# Scheduled notification foundation

User-approved scope: tenant-scoped scheduling for document and renewal events; broker alerts default on, merchant outreach explicitly company-enabled. This task implements shared delivery only. No live sends, hosted migrations, provider activation, deployment, or merge.

## Contract and ownership

`enqueueNotification(actor, input)` schedules one event occurrence and returns its durable identity/state. Input: eventKey, kind (`document` or `renewal`), dealId, audience (`broker` or `merchant`), channel (`email` or `sms`), scheduledFor, approvedAt; broker recipientUserId and bounded text payload (title/message), or merchant published templateId and optional senderId. No caller-supplied destination or workspace ID. All referenced entities resolve inside actor.workspaceId. A producer uses a stable eventKey for its logical occurrence. Per tenant/event/audience/recipient/channel identity rejects payload mutation. Clock values use UTC ISO.

Broker email recipients must be active company members with live deal visibility. Internal broker alerts do not require merchant outbound approval. Broker SMS is unavailable until a staff-consent transport exists. Merchant destinations come from the current deal contact, SMS requires existing opted-in consent, email requires explicit per-recipient notification consent, and both require explicit per-kind company enablement. Recipient suppression overrides every audience/policy. Published merchant templates render through existing template code and are rechecked before dispatch.

## Durable lifecycle

One domain event outbox records queued/sending/retry/accepted/delivered/suppressed/failed/uncertain states, a stable dispatch identity, encrypted frozen recipient/content, attempt count, next attempt time, and claim token. Claims commit before network calls. An expired sending marker becomes uncertain and is never automatically replayed. Only known rejection may retry, at most three attempts with 15-minute exponential backoff. Unknown/throwing sends remain uncertain; acceptance is distinct from delivery. Frozen payload cannot change across retries, while live policy/recipient/consent and access are rechecked each time.

Receipts are append-only and token-fenced. Provider acceptance/delivery and human reconciliation record evidence without body, address, or raw provider error. Admin reconciliation can mark delivered/accepted/failed after checking provider records, but cannot enqueue replay. Verified provider callbacks must bind tenant, notification and provider message identity; unverified client payloads cannot reconcile.

## Why a new domain outbox

Existing followup occurrences require recurring policy+deal and have only pending/sent/skipped/failed states; stale pending sends can be replayed. Lender submission outbox is restricted to lender submissions. Conversation outbox requires conversation ownership and tracks inbox threading. Reusing these for arbitrary document/renewal events would mix identities, access policies and lifecycle semantics. The domain outbox reuses `Mailbox` for Google/Microsoft delivery/reconciliation, existing system-email for broker email, `deliverClosingSms` for merchant SMS, and the existing comms cron runtime. It does not provision providers or replace their ledgers.

## Activation and tests

New dispatch is inert unless `MCA_NOTIFICATION_RUNTIME=enabled`; no new schedule is installed. Existing comms behavior is retained. Migration0068 owns policy/outbox/receipt/suppression/consent schema; schema model and journal travel together. Local disposable Postgres tests cover cross-company references/access, company enable/consent off, suppression/unsubscribe, duplicate/concurrent events, bounded known retries, killed/unknown sends, stale receipt rejection and reconciliation. Parent coordinates aggregate checks/build and independent review.

Self-review: references are tenant-resolved, broker approval differs from merchant, uncertainty never implies safe replay, retries freeze content, no raw provider secrets or external payload IDs are accepted.
