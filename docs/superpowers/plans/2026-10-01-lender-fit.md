# Lender Fit Implementation Plan

> For agentic workers: use superpowers:executing-plans inline, with independent final code review.

**Goal:** Expose trustworthy reproducible lender fit and editable criteria provenance.
**Architecture:** Extend existing criterion/scoring modules and snapshots; add a versioned authorized read projection. Keep submissions selection in existing workflow.
**Tech Stack:** Next.js 16, TypeScript, PostgreSQL/Drizzle, Node 24, pnpm 11.1.2.
**Spec:** ../specs/2026-10-01-lender-fit-design.md

## Global Constraints
- No invented provider data/terms/probabilities; broker final selection required.
- No production mutations, communications, activation, security changes, merge, or new provider.
- Source dates ISO YYYY-MM-DD; validUntil inclusive UTC, explicit as-of clock for reproducibility.
- Own isolated worktree/branch; unique test databases/output; coordinate migration and expensive checks.

## Review Focus
- Legacy snapshots without fit status must not silently become trustworthy matches.
- Expiration after snapshot creation must be detected without mutation.
- An inactive lender returning to active must invalidate its excluded snapshot.
- Invalid combinations or missing provenance must remain reviewable without invented dates.
- API consumers must not mistake a fit score for estimated terms or eligibility.

### Task 1: Criteria provenance and deterministic status
Files: funders/contracts.ts, criteria.ts, criteria-repository.ts, db/schema.ts, reserved drizzle SQL/journal; underwriting/contracts.ts, scoring.ts, policy.ts; tests/funders-criteria.test.ts and underwriting-scoring.test.ts.
Interfaces: EligibilityRule adds sourceAsOf?:string, validUntil?:string. evaluateFunderScore adds optional asOf:string and additive status/evidence. Existing callers retain signature compatibility.
- [ ] Write negative/roundtrip tests for invalid dates, expiry ordering, version bumps, missing/no/unspecified rules and deterministic scores; run red.
- [ ] Add nullable date columns after parent reserves migration number; normalize strict dates, persist/fingerprint provenance. Preserve existing sourceText and publishing permissions.
- [ ] Add deterministic fit status, missing-field reasons and evidence; include inactive funders; detect active/date drift and gate automatic selection; bump policy version.
- [ ] Run targeted criteria/scoring suites; commit.

### Task 2: Stable read API and UI
Files: underwriting/lender-fit.ts and lender-fit-contracts.ts; api/mca/underwriting/lender-fit/[dealId]/route.ts; criteria-panel.tsx; score-panel.tsx; tests/lender-fit.test.ts; docs/lender-fit.md.
Interfaces: getLenderFit(actor:DealActor,dealId:string):Promise<LenderFitResponse>, contractVersion:1, brokerSelectionRequired:true, snapshotId/null, stale/reasons, versions, ordered lenders/status/reasons/current criteria/missingData. GET requires existing requireScoreActor read and getDeal authorization; no mutation.
- [ ] Write projection tests: no snapshot, expired current rule, stale snapshot, inactive/reactivated, missing legacy metadata, deterministic order; run red.
- [ ] Implement typed pure projection with supplied asOf and server read service; HTTP route no-store; targeted tenant/scope negatives.
- [ ] Add admin date inputs and current fit statuses/version/provenance/reasons to existing panels; link existing broker selection.
- [ ] Run targeted tests/typecheck/lint, coordinate build/full-suite slot with parent, refresh graph, document API/gates; commit.

### Final verification and publication
- [ ] Independent reviewer against base 3901e7e and final head; resolve material findings with tests.
- [ ] Publish separate draft PR for human review, verify remote SHA/check state, attach PR, report external data/hosted gates.

Plan self-review: each requirement covered by a task/test; additive contracts consistent. Native inline execution already authorized by delegated instruction. No additional external tasks.
