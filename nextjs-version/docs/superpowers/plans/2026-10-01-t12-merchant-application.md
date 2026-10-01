# Invited Merchant Application Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Close save/resume, validation and scan-state gaps in the existing invited merchant funnel.

**Architecture:** Preserve encrypted draft, invitation and submission services. Extract a small client session coordinator for save/upload/submit ordering; funnel UI consumes it. Shared form-schema validation continues to run on both client and server.

**Tech Stack:** Next.js 16, React 19, TypeScript, Node 24, pnpm 11.1.2, disposable Postgres.

**Spec:** `../specs/2026-10-01-t12-merchant-application.md`

## Global Constraints
- No campaign builder/custom domains, live data/uploads, sends or hosted mutations.
- Do not edit applications/service.ts, documents/service.ts or intake/submission-review.ts.
- Do not invent legal terms or scan outcomes; consent and safe replacement depend on parent-pinned contracts.
- Independent worktree/branch/build output; targeted checks first; coordinate aggregate/build with parent.

## Review Focus
- A failed save must never submit stale answers.
- Upload responses must not discard unsaved partial answers.
- Pending/quarantined/unknown file states must not enable submission.
- Invalid dates, phones, ZIP and ownership shares must fail on server as well as UI.
- Expired/revoked/form-rebound links and cross-tenant/staff requests must remain rejected.

### Task 1: Shared required-field validation
**Files:** Modify `src/lib/mca/applications/form-schema.ts`; Test `tests/application-form-schema.test.ts`.
**Interfaces:** Consumes `DealWriteInput`; produces existing `stepError(step, answers, optional): string | undefined` and `parseMoneyInput(value): number | undefined`.
- [x] Add negative tests for impossible/future dates, invalid ZIP/phone, nonfinite/negative amounts and ownership shares; zero values remain valid.
- [x] Run schema tests and observe expected failures.
- [x] Implement validation and parseMoneyInput with calendar round-trip and finite-number checks.
- [x] Run schema tests; commit.

### Task 2: Safe client persistence and scan feedback
**Files:** Create `src/lib/mca/applications/funnel-session.ts`; Modify `src/components/mca/applications/funnel-form.tsx`, `public-application.tsx`; Test `tests/application-funnel-session.test.ts`.
**Interfaces:** `saveThenSubmit(session, save, submit): Promise<ApplicationSession>` sequences save and submit; `mergeUploadedSession(current, uploaded): ApplicationSession` retains current draft; `applicationFileError(files, months): string | undefined` gates ready/clean statements and all file states.
- [x] Write sequencing tests: failed save rejects without submission; successful save precedes submit; upload retains draft; pending/blocked/unknown files reject.
- [x] Run tests and observe failure before implementation.
- [x] Implement helpers; wire explicit save-and-exit/return, success confirmation, locked controls, accessible scan feedback/status refresh, owner removal, and load error/retry handling.
- [x] Run targeted tests and type/lint; commit.

### Task 3: Negative integration and mobile acceptance
**Files:** Modify `tests/application-forms.test.ts`; Create local synthetic browser harness/evidence under ignored `output/`; update acceptance record.
**Interfaces:** Existing public session, upload and submit routes; no new service API.
- [x] Add integration fixtures for revoked/rebound/expired scopes, invalid fields and pending/quarantined files. Verify original invitation/deal linkage remains covered.
- [x] Run targeted integration tests against unique disposable cluster/database.
- [x] Exercise real funnel component at 390/768 using synthetic intercepted HTTP responses: save/resume, failed-save-submit, upload-preserved draft, scan gate, layout overflow.
- [ ] Coordinate final build/aggregate slot with parent; request independent whole-branch review; fix material findings.
- [ ] Record missing consent/replacement contract gates, publish draft PR, attach and verify remote SHA/checks.

## Self-review
Scope maps to the three tasks. Existing tenant/correlation behavior remains in integration coverage. Consent and blocked-file replacement require pinned dependencies and remain explicit gates; no substitute contracts will be implemented. User explicitly instructed plan then execute, so implementation proceeds after this written self-review without another approval round.
