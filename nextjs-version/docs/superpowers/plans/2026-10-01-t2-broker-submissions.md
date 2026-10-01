# Broker-controlled submissions implementation plan

> **For agentic workers:** Use superpowers:executing-plans task by task. User explicitly authorized plan then execution without another approval pause.

**Goal:** Require exact durable broker approval before each lender send and exact proposal review before extracting outcomes into offers.
**Architecture:** Extend existing submission boundaries; retain intake previews and existing job/attempt/reply/offer contracts. Add a focused approval module without a database migration. Mailbox readiness comes from a pinned dependency, not a second implementation.
**Tech Stack:** Node 24, TypeScript, Next.js 16, pnpm 11.1.2, existing PostgreSQL/Drizzle migration history.
**Spec:** ../specs/2026-10-01-t2-broker-submissions.md

## Global constraints
- Separate worktree/branch from main 3901e7e; synthetic fixtures and disposable databases only.
- Exact broker package/destination review for EACH send; autonomous off.
- Preserve offers/accounting contracts; no real provider calls or provisioning.
- Coordinate full suite/build with parent. Mailbox integration waits on pinned owner contract.

## Review focus
- Missing or cross-tenant preview must fail closed before provider invocation.
- Same-classification re-extraction with changed amount invalidates confirmation.
- Concurrent re-extraction/rematching invalidates confirmation/correction under lock.
- Interrupted approved email send stays uncertain with guard flags unset.
- Existing funded/accepted offer protections and integer cents remain intact.

### Task 1: Exact approved delivery boundary
Files: create src/lib/mca/submissions/broker-approval.ts; modify deliver.ts and outbox.ts; test tests/submissions-broker-approval.test.ts.
Interfaces: assertBrokerApprovedDelivery(job: SubmissionJob): Promise<void>.
- [x] Write fixture tests for no approval, automatic intent, package/route changes, workspace/deal mismatch, confirmed exact preview.
- [x] Run targeted tests and observe missing module failure.
- [x] Validate encrypted confirmed application snapshot against job's exact approved package; reject automatic intent before provider invocation. Audit via existing activity records.
- [x] Run tests; preserve completed-attempt observation before approval validation.

### Task 2: Pin broker outcome proposals
Files: modify src/lib/mca/submissions/extract-outcomes.ts and src/components/mca/submissions/reply-queue.tsx; test tests/submissions-extract.test.ts.
Interfaces: ExtractOutcomeView.proposalKey: string; ExtractRunInput.expectedProposalKey and ExtractCorrectionInput.expectedProposalKey.
- [x] Add same-classification changed-term and stale-correction negative tests; observe failures.
- [x] Hash proposal terms/evidence/match, expose key, require exact key; recheck locked reply row/current match before writes; send key from UI on confirmation/correction.
- [x] Run extraction regression tests including scoped API permissions, funded guards and cents conversion.

### Task 3: Uncertain send and mailbox dependency
Files: queue.ts, outbox.ts, tests/submissions-outbox.test.ts; mailbox consumer only after pinned contract arrives.
- [x] Add approved interrupted-send tests with guard flags unset, and cross-tenant reconciliation denial; observe failures.
- [x] Preserve ambiguity protection independent of flags for approved sends; check reconciliation deal access/operator authority and block repeat queueing until not-sent reconciliation.
- [x] Consume pinned mailbox API only after parent supplies commit/contract; record external activation gates.

### Task 4: Verification and draft review
- [x] Targeted negative/role/tenant tests, typecheck/lint; coordinate isolated build/aggregate with parent.
- [x] Refresh Graphify; independent fresh review and fix findings.
- [ ] Commit/push unique branch, open/attach draft PR, verify remote SHA/checks and report remaining gates.

Self-review: all independent requirements assigned; reuse existing preview schema with nullable intake linkage; no offer contract change. Ruling: user's explicit plan-and-execute authorization supersedes skill's second plan-confirmation pause. Final reviewer delegation required by requesting-code-review skill; no additional external tasks.

Execution ledger:
- Broker gate red missing-module -> 5/5 green on disposable cluster 55472.
- Exact proposal key regression red missing key -> extraction suite 9/9 green; API-key commits denied, existing offer/cents/funded protections exercised.
- Compatibility audit: generic SelectionPanel and assistant call legacy confirm. Added generic exact preview/confirm UI + supported assistant redirect error. Local migration candidate 0070 makes existing preview intake_id nullable; no fabricated intake, no grants/auth migration. Parent notified before commit.
- Independent review found retry endpoint bypass, adapter/webhook ambiguity, completed attempt recovery, worker observation and webhook routing query redaction. Fix pass blocks submit retry, preserves uncertain outcomes and transport-wide observation, expands scoped broker reconciliation and exposes resolved credential-free webhook URL.
- Generic approval negative test red missing module -> green with nullable preview migration. Added operator reconciliation UI and role/tenant negative tests.
- Mailbox dependency pinned to PR208/e7b9361c1d5cf4451d8fd71825f7f1737759c158; T2 is stacked on that exact commit. Its company/merchant incoming mailbox readiness is surfaced separately from submission sender preflight; unavailable ingestion requires manual reply review.
- Migration allocation: only real own 0070_submission_previews journal entry retained against main (idx59 here). Combined integration must reindex 0068 notifications idx59, 0069 Voice idx60, 0070 T2 idx61. Parent explicitly confirmed not to fabricate foreign entries. No notification/voice SQL included.
- Notification owner confirmed no scheduler overlap; jobs/{queue,worker}.ts diff only broadens existing submission_delivery observation to approved email/API/webhook attempts regardless of optional legacy flag. No scheduler/kind/lease rewrite.
- Existing reply ingestion correlation, deduplication, out-of-order status transitions and offer/accounting modules reused; new full proposal key and locked recheck protect human term approval.
- Public generic deal flow now requires action=preview then previewId confirmation. Assistant legacy confirmation and API key confirmation explicitly direct the broker to the supported deal Submit to funders preview UI; API keys cannot approve sends. Internal underwriting queue can record jobs but unapproved/automatic delivery is rejected at provider boundaries.
- Second independent review found post-provider bookkeeping could erase receipts. Provider outcomes now survive audit/job/cache failures and completed-attempt recovery records activity; synthetic audit outage tests verify accepted and uncertain outcomes, one provider invocation.
- Parent full aggregate/build allocation remains queued; proceed with draft carrying these explicit remaining gates.

Final focused evidence: 167/167 tests pass, zero skipped; final receipt recovery group 23/23 passes after reloading terminal jobs. Typecheck passes. Full lint passes with 0 errors/16 existing warnings; final changed recovery files have no lint output. Independent reviewer final inspection reports no remaining blocking findings. Full aggregate and production build remain queued with parent. Graphify AST update and clustering completed; refreshed output preserved outside PR at /tmp/fundlane-t2-graphify-final to avoid bulk generated graph churn.
