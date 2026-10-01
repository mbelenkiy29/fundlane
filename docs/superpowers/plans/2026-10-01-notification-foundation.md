# Notification foundation implementation plan

> For agentic workers: use superpowers:executing-plans inline. User explicitly requested plan then execute; parent arranges independent review.

Goal: provide one safe scheduled notification contract for document/renewal producers.
Architecture: tenant-scoped event outbox and policy/consent repository; fenced delivery worker delegates to existing providers and comms cron.
Tech stack: Node24, TypeScript, pg/Drizzle, node:test, existing adapters.
Spec: docs/superpowers/specs/2026-10-01-notification-foundation-design.md

## Global constraints

No production data/credentials, hosted migrations, live sends, paid provisioning, schedule enablement, Actions enablement or merge. Reserve migration0068; parent owns shared coordination. Runtime defaults off. Preserve original merchant approvedAt and provider contracts.

## Review focus

- Changing membership/deal visibility between enqueue and dispatch must suppress disclosure.
- Duplicate races must return the same durable identity and never claim twice.
- Process death after provider acceptance must leave uncertain, never replay.
- Consent/policy revocation between enqueue and retry must block send.
- Provider errors/receipts must not leak payloads or falsely claim delivery.

### Task 1: durable contract and tenant policy

Files: notifications/contracts.ts, notifications/service.ts, db/notifications.ts, drizzle0068 and journal, tests/notifications.test.ts.
Interfaces: enqueueNotification(actor,input); getNotification(actor,id); setNotificationPolicy(actor,{kind,merchantEnabled,brokerEnabled}); setNotificationConsent(actor,{dealId,channel,enabled}); suppressNotificationRecipient(actor,{dealId,channel}) resolve addresses internally.
- [ ] Write failing tests for cross-company deal/broker/template, merchant disabled, consent off, duplicates/conflicting payload and suppression.
- [ ] Run focused node:test, expect missing module/exports RED.
- [ ] Implement tenant-resolved repository, strict validation, encrypted payload, dedup and policies, schema matching migration.
- [ ] Run focused tests, expect PASS. Commit.

### Task 2: claims, adapters, reconciliation and runtime

Files: notifications/worker.ts, notifications/transport.ts, comms/scheduler.ts, tests/notifications.test.ts.
Interfaces: runScheduledNotifications(nowIso,limit); NotificationTransport(message) returns accepted/delivered/retry/failed/uncertain; reconcileNotification(actor,id,{outcome,evidence}); newDispatchReceipt scoped by tenant/id/token.
- [ ] Write failing tests for concurrent claim, retry bounded3/backoff15m, unknown send and expired marker, stale token, pause/reapproval and live revoked consent/member access, receipt evidence, reconciliation no resend.
- [ ] Run focused tests, expect missing worker exports RED.
- [ ] Implement commit-before-send claims, token-fenced receipts, live preflight, frozen payload, provider adapters and default-off comms integration.
- [ ] Run focused tests, expect PASS. Commit.

### Task 3: final verification and handoff

Files: docs shared contract/activation, test evidence.
- [ ] Self-review spec coverage and diff; report code pin to parent for independent review.
- [ ] Run targeted suites/typecheck/lint, coordinate aggregate/build slot with parent; expect zero new failures and record actual outcomes.
- [ ] Refresh Graphify; fix material review findings with RED/GREEN tests.
- [ ] Publish draft PR, verify remote head and check/preview outcomes; no merge.

Self-review: all interface names align; policy and consent affect enqueue and live dispatch; immutable encrypted payload protects retry identity. No frontend or producer workflows in scope.
