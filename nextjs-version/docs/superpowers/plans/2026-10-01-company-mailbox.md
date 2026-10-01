# Company Mailbox Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, with a fresh whole-branch reviewer.

**Goal:** Expose truthful mailbox readiness and safe disconnect for onboarding.
**Architecture:** Reuse sender authorization and OAuth; readonly readiness wraps authorized merchant senders and the existing consumer heartbeat. Reuse the connection UI rather than a second grant flow.
**Tech Stack:** Next.js, TypeScript, pg, node:test; Node24, pnpm11.1.2.
**Spec:** ../specs/2026-10-01-company-mailbox-design.md

## Global Constraints
No production data, live sends/grants, scheduler/aggregator edits or schema changes. Build/full suite only in parent-allocated slot. Notification proposal remains unpinned and is not consumed.

## Review Focus
- Foreign/private/submission senders never count toward readiness.
- Healthy grant with disabled/stale consumer must not claim overall ready.
- Disconnect retains history and pending/unknown message identities.
- Pending or in-flight OAuth callback cannot reverse disconnect.
- Refreshable token expiration does not falsely require reconnect.

### Task 1: readiness contract and disconnect
Files: new senders/readiness.ts, new api/mca/senders/readiness/route.ts; modify senders/service.ts; tests/email-conversations.test.ts.
Produces: getMailboxReadiness(actor: DealActor): Promise<MailboxReadiness>, authenticated GET readiness endpoint. MailboxReadiness has ready:boolean, consumer:{state,lastCompletedAt?}, providers:{google:boolean,microsoft:boolean}, senders:{id,provider,fromAddress,state,connection,canReconnect}[]. Connection is connected/connect_required/reconnect_required/disconnected.
- [x] Add failing readiness/API role and isolation assertions; add disconnect credential/state invalidation and callback race assertions.
- [x] Run targeted email-conversations tests; confirm new tests fail on missing export/behavior.
- [x] Implement readonly readiness using listSenders and heartbeat lease. Use ten-minute stale threshold. Session-only route uses requireWorkspaceAccess and actorForDeals. Disconnect transaction clears OAuth credential and states. Callback transaction locks sender and rejects changed updatedAt/state/credential before saving.
- [x] Run email-conversations and sender tests against disposable PostgreSQL; confirm pass and no external requests.
- [ ] Commit deliverable.

### Task 2: onboarding connection component and evidence
Files: components/mca/email/connections.tsx; new components/mca/email/company-mailbox-connections.tsx; docs/email-conversations.md.
Consumes: Task1 readiness API, existing personal OAuth and revoke endpoints.
Produces: CompanyMailboxConnections({onChanged?:()=>void}) React component.
- [x] Show consumer/provider gates, reuse PersonalEmailConnections, add authorized disconnect with clear preservation copy; refresh readiness after actions and poll.
- [x] Run typecheck and focused lint, review UI state/error handling.
- [ ] Update activation docs and parent contract; commit.
- [ ] Request independent branch review, fix important findings, coordinate full lint/build/aggregate slot, publish draft PR and verify remote SHA/checks.

Self-review: all spec behavior assigned; no shared notification assumptions; no migrations. Existing adapters remain authoritative and targeted suite pins their safety behavior.

Execution ledger: Spec/plan self-reviewed before code; native inline execution authorized by user. Task1 RED missing readiness export, then targeted tests GREEN39/39 after correcting synthetic lease required field and queue result property. Ruling: cached Mailbox can retain token after disconnect; add live sender/credential check before each provider request. Regression RED missing expected rejection. This stays within disconnect requirement; no provider API changes.

Review ledger: Fresh reviewer found two OAuth race windows. Added deterministic initiation-before-state-save and consumption-before-snapshot regressions; both RED on prior behavior, GREEN after shared sender locking. Final targeted43/43; typecheck/focused lint pass. Independent re-review clean. Graphify refreshed locally; generated whole-graph version rewrite excluded from feature PR and saved separately in /tmp/fundlane-mailbox-graph. Full build/lint slot still pending parent.
