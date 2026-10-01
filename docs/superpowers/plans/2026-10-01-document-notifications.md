# Document Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Native execution is explicitly selected by delegated plan-and-execute instruction.

**Goal:** Produce safe missing/requested/stale document broker alerts and optional enabled merchant reminders.

**Architecture:** Pure condition derivation consumes existing vault, underwriting periods and closing requests. Tenant/role-scoped producer queues the foundation; a live guard suppresses resolved or invalid requests. Separate UI calls the producer API.

**Tech Stack:** TypeScript, Next.js, existing pg/Drizzle, React and node:test.

**Spec:** docs/superpowers/specs/2026-10-01-document-notifications-design.md

## Global Constraints

No transports, new schedulers, external sends, production mutations or edits to documents/service.ts. Foundation exact1e56cc77b1ca5a5568e36cb4d7cd91e17a5fde27 and parent-authorized hooks only. Clean scanned current versions only. Statement period is previous completed UTC month. Independent output/build worktree; disposable PG55481.

## Review Focus

- Pending `ready` uploads must remain missing.
- Latest unsafe replacement must prevent older lineage version satisfying a request.
- UTC first-of-month/year boundary rolls required period deterministically.
- Requests resolved or links revoked after enqueue suppress before send.
- Repeated user actions must retain original event identity and approval.

### Task 1: Derive document conditions

Files: create nextjs-version/src/lib/mca/documents/notification-facts.ts; tests/document-notification-facts.test.ts.
Produces `previousCompletedUtcMonth(clock:string):string`, `deriveDocumentConditions(facts:DocumentNotificationFacts):DocumentCondition[]`.
- [x] Write failing tests asserting clean versus every unsafe state, latest versions, previous month/year/leap/offset, malformed/future periods, open/received/verified/waived tasks.
- [x] Run node --conditions=react-server --import tsx --test tests/document-notification-facts.test.ts; expected missing module failure then meaningful assertion red.
- [x] Implement pure types and derivation, no filename/upload-date freshness inference.
- [x] Run above; expected all pass; commit.

### Task 2: Tenant producer and live guard

Files: create documents/notification-service.ts and documents/notification-condition.ts; tests/document-notifications.test.ts; docs/document-notifications.md.
Consumes facts and pinned foundation `enqueueNotification`, live condition registration. Produces `documentNotificationSnapshot(actor,dealId,clock?)`, `enqueueDocumentNotifications(actor,input)`, `registerDocumentNotificationCondition()`.
- [x] Write failing disposable DB tests for wrong company/rep, dedup/concurrency, live resolution, expired/revoked/consumed/foreign links, policy/consent/optout, unknown outcomes/reconciliation.
- [x] Run focused tests; expected missing behavior failure.
- [x] Implement scoped facts query, stable event identity, safe persisted link checks and queued-state result; no delivery duplication. Use stable original schedule/approval for duplicates.
- [x] Run focused tests and typecheck; expected green; commit. Report exact guard pin to parent for foundation cron bootstrap.

### Task 3: Document alert UI/API

Files: create src/app/api/mca/documents/notifications/route.ts, src/components/mca/documents/document-notifications.tsx; modify document-panel.tsx; tests/document-notification-ui.test.tsx (or node-compatible ts).
Consumes snapshot/producer; produces authenticated read/write route and accessible alert panel.
- [x] Write failing route/SSR UI tests for missing-month labels, role/tenant rejection and precise delivery state; verify red.
- [x] Implement panel and route with existing auth/client components; require explicit merchant action and published template/requestlink; preserve original approval across retries.
- [x] Run targeted tests/typecheck/lint; expected green; commit.

### Task 4: Configured bounded automatic discovery

Files: create db/document-notifications.ts; migration0072 and own actual journal entry; documents/notification-automation.ts, notification-discovery.ts; API automation route and configuration UI. Modify guard key/live checks and one worker hook only.
Consumes existing cadence helper/schema, foundation deadline, tenant deal/membership/link APIs. Produces discoverDocumentNotifications({clock,limit,deadlineMs}) and read/saveDocumentAutomation(actor,input).
- [x] Write failing tests: absent/default config no merchant discovery; explicit reasons/schedule; durable approver/version; assigned eligible broker only; keyset page continuation/fairness/cap/deadline; concurrent/restarted occurrence dedup; tenant/role denial; config/pause/consent/link/resolution revocation suppresses.
- [x] Implement reserved0072 dedicated config and cursor (journal next actual index60 after foundation0068; integration reindex documented), no fake entries0069-0071.
- [x] Implement admin config API/UI and discovery hook into existing runtime; no generic followup opt-in inference or updated_at approval.
- [x] Run focused tests/type/lint and independent review of added scope; expected green; commit.

### Final verification

- [ ] Parent-coordinated full test/lint/build slot, unique outputs, Graphify refresh.
- [x] Independent review arranged within authorized local review; fix important findings with red/green evidence.
- [x] Draft PR [219](https://github.com/mbelenkiy29/fundlane/pull/219), stacked on foundation PR212. Verify final remote head/checks at handoff; no merge. Hosted/provider activation and parent aggregate/build remain release gates.

Self-review: scope and interfaces checked; unknown shared guard/template extension is a pinned dependency, not invented. All review-focus cases belong to tasks1/2. Reserved0072 stores only explicit automation policy/cursor/approval; existing requirements/links and consent semantics are reused. Spec and plan executed under explicit user instruction.
