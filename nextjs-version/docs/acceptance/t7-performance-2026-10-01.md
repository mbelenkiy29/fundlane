# T7 reporting verification — 2026-10-01

Base: 3901e7e8a41b72bd08177cbd0c7b5967d9a7cb09. Branch: codex/t7-reports-20261001. Worktree: /Users/mbele/Documents/Codex/2026-09-30/task-9/fundlane-t7.

## Implemented

Reports page now includes broker/company performance: unique created/submitted/offered/funded deals, current pipeline for created cohort, committed funding-event volume with reversal evidence, intersecting cohort conversion versus explicitly labeled event activity ratios, recorded renewal source advances, and four separate commission measures. Financial data requires both existing finance permissions; estimates use recorded selected revisions only. Fees and void ledger rows are excluded. No accounting mutations, shared calculator changes, schema migrations, security configuration changes, provider calls or activation.

GET /api/mca/reports/performance accepts existing basis/from/to/membershipIds/funderIds/sourceIds/batchIds filters. JSON returns {report,csvSnapshot}; format=csv serves the same sanitized serialization. The browser exports csvSnapshot from the displayed report without another query. Current assignment attribution, inclusive local dates, pipeline/cohort semantics and current ledger restatement are explained in the report and CSV.

## Verified

Disposable PostgreSQL16 at 127.0.0.1:55479, /tmp/fundlane-t7-pg-20261001. Harness-created unique databases only; no hosted credentials.

- Baseline rep-funnel: 11/11 passed before implementation.
- RED: missing performance service/API. GREEN service/API with unique five-submission deal count, funding/commission reconciliation and finance redaction.
- RED: expected unreceived commission wrongly appeared in collected cohort; excluded expected zero-receipt rows. GREEN regression.
- Independent read-only reviewer inspected 3901e7e..d7358a9. Important ambiguity finding: date/funder filter could hide competing selected offers. RED reproduced unknownCount 0 != 1, grouping moved before filters, GREEN regression for both date and funder filters. Display definition mismatch clarified with funded-stage exception (any committed funding event in the window, unique per deal within each report).
- Final command: MCA_TEST_DATABASE_ADMIN_URL=postgresql://mbele@127.0.0.1:55479/postgres node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 tests/performance-report.test.ts tests/milestone06-rep-funnel.test.ts tests/milestone06-team-profit.test.ts tests/milestone06-lead-roi.test.ts tests/milestone06-funder-analytics.test.ts tests/report-explained-values.test.ts
- Final result: 50 tests passed, 0 failed, 0 skipped.
- pnpm typecheck: passed after final changes.
- Scoped ESLint on changed service/contracts/routes/UI/page/tests: passed, zero warnings/errors. Full pnpm lint: zero errors, 16 existing warnings in unchanged files.
- git diff --check: passed.
- Graphify query used for navigation; update and cluster-only --no-label succeeded. Refreshed graph preserved separately from PR to avoid broad generated artifact churn.

A parallel report run emitted an existing team-profit test cleanup error (terminating connection due to administrator command after all its assertions passed). Repeated with repository-standard --test-concurrency=1: final 50/50 clean. This transient is disclosed, not counted as passing evidence.

## Remaining gates

Full pnpm test and production build have not run: parent coordinates exclusive allocation across feature tasks; messages requested a slot and no slot was received before draft publication. No Actions enablement requested. Hosted authenticated UI/mobile/browser and real workspace data reconciliation are unverified. These are premerge gates, not external activation claims. User reviews definitions, authorization behavior and draft PR before any merge.

No hypothetical broker scenario calculation is duplicated: T7 reads existing persisted selected revision commission and renewal records; T8 owns hypothetical deterministic estimates separately. No pinned dependency is required for this report.

## Execution rulings

- Native self-review then execute honored explicit delegated instruction; no repeated skill approval prompts. Cost if wrong: human must revise definitions before merge.
- Located repository worktree created manually because projectless task had no selected Fundlane native-project context. Cost if wrong: app-managed worktree attachment absent; exact path/branch supplied.
- Incomplete shared-checkout dependency symlink replaced by isolated frozen-lockfile install. Cost: local disk only.
- Service/API committed together because shared fixture regressions span both; RED/GREEN order preserved. Cost: coarser bisect granularity.
- Reviewer definition issue treated as material and clarified. Cost if wrong: funded-stage semantics require human decision.
- Reviewer declined full suite/build/runtime and production/hosted/external reconciliation: retained as human gates. Cost: broader and hosted regressions remain possible until those checks.

Deferred minors: none; reviewer definition issue was addressed. No merges or external communications/calls occurred.
