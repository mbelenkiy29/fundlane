# CRM Detail Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent cross-deal UI state leakage and verify the existing brokerage pipeline.
**Architecture:** Keep deals services/APIs and the current UI. Introduce a focused detail session used through React useSyncExternalStore to guard async selection lifecycle.
**Tech Stack:** Next.js 16, React 19, TypeScript, node:test, disposable PostgreSQL.
**Spec:** docs/superpowers/specs/2026-10-01-crm-detail.md

## Global Constraints
- CRM/deals UI, tests and docs only; no shared schema/API/role changes.
- Node 24, pnpm 11.1.2. Synthetic local disposable databases only.
- Preserve existing stage defaults; no client-specific stage policy.
- Draft PR for human review, no merges or production/provider changes.

## Review Focus
- Slow A detail request finishes after B: B stays selected.
- Close/reopen same ID: prior mutation/load cannot overwrite the new session.
- Active load failure: loading stops, error shows, Retry resolves current ID.
- Deal switching: note/status/conflict/error/edit state cannot cross selection.
- Refresh races with newer mutation: current version never regresses.

### Task 1: Detail selection lifecycle
**Files:** Create nextjs-version/src/components/mca/deals/detail-session.ts; test nextjs-version/tests/crm-detail-session.test.ts; modify nextjs-version/src/app/(dashboard)/pipeline/components/pipeline-workspace.tsx.
**Interfaces:** Consumes fetch returning DealDetail with id/version; produces createDealDetailSession<T extends {id:string;version:number}>(load:(id:string)=>Promise<T>) with subscribe/getSnapshot/open/close/capture/isCurrent/update/setNote/setTransition, state id/selected/loading/failure/note/transition. Snapshot identity is stable until changed.
- [x] Write controlled deferred-load tests: A/B reversed, stale error, close/reopen, active failure/retry, note/transition clearing, version regression and late mutation guards.
- [x] Run node --import tsx --test tests/crm-detail-session.test.ts; expected failure for missing session module.
- [x] Implement the session; wire detail loading/error/Retry UI and reset edit/form/conflict/fieldErrors/saving on open. Guard save, transition, note, workflow and assistant completion against captured session. Close invalidates requests and unmount cleanup closes the session.
- [x] Run same test command; expected all pass. Run targeted ESLint and typecheck; expected exit 0.
- [ ] Commit lifecycle fix and tests.

### Task 2: Synthetic brokerage journey
**Files:** Modify nextjs-version/tests/imports-core.test.ts; create nextjs-version/docs/acceptance/crm-pipeline-audit.md.
**Interfaces:** Consumes existing previewSpreadsheetImport/commitSpreadsheetImport/getDeal/transitionDeal/addDealNote/updateDealRecord/listDeals, no produced API.
- [x] Add a synthetic import assigned to rep A; assert owner/assigned rep access, contact/source data, stage and note history and idempotent import retry.
- [x] Assert unassigned rep and foreign admin read/update/transition/note fail; foreign assignment, hierarchy escalation, illegal stage, incomplete submit and stale version reject without record changes.
- [x] Run imports-core, deals acceptance and deals HTTP targeted tests on local Postgres port 56416; expected all pass. These characterize already implemented behavior; no artificial RED for existing correct behavior.
- [x] Document verified scope, stage/role assumptions, existing queues and remaining hosted/browser acceptance.
- [ ] Commit regression evidence/docs.

### Final verification and publication
- [ ] Request independent code review against the complete branch; address Important/Critical findings with regression tests.
- [ ] Coordinate aggregate/build slot with parent. Run typecheck/lint/build and aggregate suite as available; record exact results and blockers.
- [ ] Refresh Graphify; inspect generated changes, avoid unnecessary large graph commits.
- [ ] Push unique branch, create draft PR, attach PR, verify remote head and checks.

Self-review: all spec behaviors map to Task 1/2; no schema or overlapping feature contracts. Pre-flight: no shared interfaces between tasks. Ruling: explicit user plan-and-execute authorization means self-reviewed plan proceeds without a second approval. Existing correct-behavior regression tests need no fabricated failing implementation. Full-suite/build scheduling remains coordinated with parent.
