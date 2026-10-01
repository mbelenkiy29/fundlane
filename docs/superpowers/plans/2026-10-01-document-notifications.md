# Document Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Native execution is explicitly selected by delegated plan-and-execute instruction.

**Goal:** Produce safe missing/requested/stale document broker alerts and optional enabled merchant reminders.

**Architecture:** Pure condition derivation consumes existing vault, underwriting periods and closing requests. Tenant/role-scoped producer queues the foundation; a live guard suppresses resolved or invalid requests. Separate UI calls the producer API.

**Tech Stack:** TypeScript, Next.js, existing pg/Drizzle, React and node:test.

**Spec:** docs/superpowers/specs/2026-10-01-document-notifications-design.md

## Global Constraints

No transports, schedulers, migrations, external sends, production mutations or edits to documents/service.ts. Foundation41a4264 and subsequent parent-pinned contracts only. Clean scanned current versions only. Statement period is previous completed UTC month. Independent output/build worktree; disposable PG55481.

## Review Focus

- Pending `ready` uploads must remain missing.
- Latest unsafe replacement must prevent older lineage version satisfying a request.
- UTC first-of-month/year boundary rolls required period deterministically.
- Requests resolved or links revoked after enqueue suppress before send.
- Repeated user actions must retain original event identity and approval.

### Task 1: Derive document conditions

Files: create nextjs-version/src/lib/mca/documents/notification-facts.ts; tests/document-notification-facts.test.ts.
Produces `previousCompletedUtcMonth(clock:string):string`, `deriveDocumentConditions(facts:DocumentNotificationFacts):DocumentCondition[]`.
- [ ] Write failing tests asserting clean versus every unsafe state, latest versions, previous month/year/leap/offset, malformed/future periods, open/received/verified/waived tasks.
- [ ] Run node --conditions=react-server --import tsx --test tests/document-notification-facts.test.ts; expected missing module failure then meaningful assertion red.
- [ ] Implement pure types and derivation, no filename/upload-date freshness inference.
- [ ] Run above; expected all pass; commit.

### Task 2: Tenant producer and live guard

Files: create documents/notification-service.ts and documents/notification-condition.ts; tests/document-notifications.test.ts; docs/document-notifications.md.
Consumes facts and pinned foundation `enqueueNotification`, live condition registration. Produces `documentNotificationSnapshot(actor,dealId,clock?)`, `enqueueDocumentNotifications(actor,input)`, `registerDocumentNotificationCondition()`.
- [ ] Write failing disposable DB tests for wrong company/rep, dedup/concurrency, live resolution, expired/revoked/consumed/foreign links, policy/consent/optout, unknown outcomes/reconciliation.
- [ ] Run focused tests; expected missing behavior failure.
- [ ] Implement scoped facts query, stable event identity, safe persisted link checks and queued-state result; no delivery duplication. Use stable original schedule/approval for duplicates.
- [ ] Run focused tests and typecheck; expected green; commit. Report exact guard pin to parent for foundation cron bootstrap.

### Task 3: Document alert UI/API

Files: create src/app/api/mca/documents/notifications/route.ts, src/components/mca/documents/document-notifications.tsx; modify document-panel.tsx; tests/document-notification-ui.test.tsx (or node-compatible ts).
Consumes snapshot/producer; produces authenticated read/write route and accessible alert panel.
- [ ] Write failing route/SSR UI tests for missing-month labels, role/tenant rejection and precise delivery state; verify red.
- [ ] Implement panel and route with existing auth/client components; require explicit merchant action and published template/requestlink; preserve original approval across retries.
- [ ] Run targeted tests/typecheck/lint; expected green; commit.

### Final verification

- [ ] Parent-coordinated full test/lint/build slot, unique outputs, Graphify refresh.
- [ ] Independent review arranged by parent; fix important findings with red/green evidence.
- [ ] Draft PR, verify remote head/checks, report remaining hosted/provider/bootstrap gates. No merge.

Self-review: scope and interfaces checked; unknown shared guard/template extension is a pinned dependency, not invented. All review-focus cases belong to tasks1/2. No migration required; existing requirements/links reused. Spec and plan executed under explicit user instruction.
