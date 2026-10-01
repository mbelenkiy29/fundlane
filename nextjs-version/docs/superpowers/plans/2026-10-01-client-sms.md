# Client SMS Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Repair integration gaps and publish reusable number ownership/readiness without activating Twilio.

**Architecture:** Extend existing SMS modules and account contracts. Reuse the existing transport and database; no second scheduler, provisioning path or migration.

**Tech Stack:** Next.js 16, TypeScript, PostgreSQL, node:test, pnpm 11.1.2 / Node 24.

**Spec:** docs/superpowers/specs/2026-10-01-client-sms.md

## Global Constraints
- New numbers only; no paid provisioning, credential configuration, live messages, production mutation, merges or Actions enablement.
- Readiness is configuration evidence only; provider/carrier activation remains a human gate.
- Internal workspace-keyed services require authorized callers; HTTP routes retain existing tenant/role checks.
- Do not modify generic notification scheduling/retries or unpinned APIs.

## Review Focus
- Missing/foreign number: ownership query returns absent and readiness cannot become true.
- Mismatched account sender: readiness blocks even when carrier number is active.
- Malformed callback origin: readiness returns a blocker without exposing credentials or throwing during rendering.
- Unsupported opt-out event: reject before writing an inbox message or suppression.
- Late inbox response/uncertain send: never show/send previous conversation or permit a changed payload under its reserved key.

### Task 1: Publish ownership and managed readiness contract
**Files:** Create `src/lib/mca/sms/number-ownership.ts`; modify `managed.ts`, `contracts.ts`, `onboarding.ts`, `service.ts`; extend `tests/sms-onboarding.test.ts`.
**Interfaces:** Produce `getCompanyNumberOwnership(workspaceId: string, numberId: string)` and `managedReadiness(workspaceId: string, accountId: string)`; retain `managedReady(): Promise<boolean>`. Ownership reports data only, not Voice authorization/readiness. Existing company/provider functions resolve server-only tenant credentials.
- [ ] Add tests for ownership isolation, blocker details, mismatched sender and malformed origin; run and observe failure.
- [ ] Implement readonly lookup and readiness; retain boolean compatibility; run targeted suite.
- [ ] Commit contract and share pinned SHA with voice and parent.

### Task 2: Integrate readiness and repair callback/inbox gaps
**Files:** Modify `onboarding-panel.tsx`, `composer-panel.tsx`, `inbox-panel.tsx`, `service.ts`; create/extend focused SMS tests.
**Interfaces:** `SmsAccount.readiness?` carries codes/messages; onboarding numbers expose the same result. Inbox uses existing messages endpoint and immutable retry payload.
- [ ] Add negative callback and draft-state tests, observe failure.
- [ ] Render readiness blockers, validate inbound type first, use guarded inbox selection/request state and retain uncertain draft; run focused tests.
- [ ] Commit integration and docs.

### Task 3: Verification and review
- [ ] Request parent aggregate/build slot; run targeted role/tenant/callback/suppression/repeated-send suites and final typecheck/lint.
- [ ] Get independent Superpowers review; fix material findings with regression tests.
- [ ] Run allocated build/aggregate, refresh Graphify, document limitations and publish draft PR. Verify remote SHA/checks and attach PR.

## Self-review
Coverage maps each design requirement to tasks 1–3. Existing company/provider resolver is sufficient for voice, avoiding duplicate credential ownership. No dependency on proposed notification API and no migration required. User explicitly authorized plan then execute; proceed inline after this recorded self-review.
