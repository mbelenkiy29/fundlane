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
- [x] Write negative/roundtrip tests for invalid dates, expiry ordering, version bumps, missing/no/unspecified rules and deterministic scores; run red.
- [x] Add nullable date columns after parent reserves migration number; normalize strict dates, persist/fingerprint provenance. Preserve existing sourceText and publishing permissions.
- [x] Add deterministic fit status, missing-field reasons and evidence; include inactive funders; detect active/date drift and gate automatic selection; bump policy version.
- [x] Run targeted criteria/scoring suites; commit.

### Task 2: Stable read API and UI
Files: underwriting/lender-fit.ts and lender-fit-contracts.ts; api/mca/underwriting/lender-fit/[dealId]/route.ts; criteria-panel.tsx; score-panel.tsx; tests/lender-fit.test.ts; docs/lender-fit.md.
Interfaces: getLenderFit(actor:DealActor,dealId:string):Promise<LenderFitResponse>, contractVersion:1, brokerSelectionRequired:true, snapshotId/null, stale/reasons, versions, ordered lenders/status/reasons/current criteria/missingData. GET requires existing requireScoreActor read and getDeal authorization; no mutation.
- [x] Write projection tests: no snapshot, expired current rule, stale snapshot, inactive/reactivated, missing legacy metadata, deterministic order; run red.
- [x] Implement typed pure projection with supplied asOf and server read service; HTTP route no-store; targeted tenant/scope negatives.
- [x] Add admin date inputs and current fit statuses/version/provenance/reasons to existing panels; link existing broker selection.
- [x] Run targeted tests/typecheck/lint, coordinate build/full-suite slot with parent, refresh graph, document API/gates; commit.

### Final verification and publication
- [x] Independent reviewer against base 3901e7e and final head; resolve material findings with tests.
- [ ] Publish separate draft PR for human review, verify remote SHA/check state, attach PR, report external data/hosted gates.

Plan self-review: each requirement covered by a task/test; additive contracts consistent. Native inline execution already authorized by delegated instruction. No additional external tasks.

## Execution ledger
- Native inline execution under user's explicit delegated plan-and-execute authorization; spec/plan self-review completed before product edits, planning commit2728319.
- Task1 complete: criteria date normalization/persistence/fingerprint and deterministic status implemented; initial new persistence test failed on missing sourceAsOf, then passed after migration/repository changes. Missing/unspecified rules now require review. Existing synthetic fixtures explicitly supply their own source facts.
- Task2 complete: version1 read API uses repeatable-read, read-only transaction; role/tenant/scope negatives and no snapshot insertion verified. Existing manual/scan editors and broker selection route reused.
- Task1 Ruling: nullable date facts use text columns matching existing date storage conventions; service validates real ISO dates. Cost if wrong: invalid direct SQL values require broker review (readiness fails closed), never fabricated date data.
- Task1 Ruling: unique0074 migration appended at actual next main journal idx59 without unrelated migration placeholders. Parent notified; combined feature integration must reconcile journal indices. Cost if wrong: integration migration replay blocked until journal corrected; no hosted migration applied.
- Task2 Ruling: raw legacy score eligibility remains hard-rule evidence for existing consumers; all actionable suggestions and auto-submit decisions require explicit matched fitStatus. Public fit API exposes no numeric score for review/stale entries. Cost if wrong: an unknown future consumer could misuse raw eligibility; use version1 fit API for new consumers.
- Independent review /root/review_t6 found P1 worker bypass and P2 scan date erasure. Both fixed in one pass: worker decision test RED submit→GREEN skipped; shared source draft serializer regression RED missing module→GREEN exact date roundtrip; DB scan accept/rollback preserves dates. Worker integration verifies missing/future source dates and unknown soft evidence create zero jobs.
- Final task verification:63/63 tests,0 failures/skips across auto-submit, criteria/import/scan, analysis/scoring, fit projection, source draft suites on disposablePG55446. Final typecheck pass. Final full lint0 errors/16 pre-existing warnings.
- Graphify refreshed after final changes; generated whole-graph output retained in /tmp/fundlane-t6-graph-refresh and excluded from feature diff to avoid unrelated repository churn.
- Aggregate/build remain queued awaiting parent's exclusive allocation; no parallel expensive run launched. Hosted browser/source collection/migration acceptance remains human review gate.
- Deferred minors: none reported by independent reviewer.
