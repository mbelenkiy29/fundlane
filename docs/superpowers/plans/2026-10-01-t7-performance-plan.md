# T7 performance implementation plan

Spec: docs/superpowers/specs/2026-10-01-t7-performance-design.md
Execution: native in this task, explicitly authorized by delegation; self-review plan/spec before edits. Base 3901e7e8a41b72bd08177cbd0c7b5967d9a7cb09.

Global constraints: reports ownership only, no accounting mutations/calculation changes, no production/provider access, no merges. All finance sanitized before serialization. Estimates depend only on persisted selected revision; no external dependency needed now.

### Task 1: Implement reconciled report and regression tests
Files: nextjs-version/src/lib/mca/reports/performance.ts, performance-contracts.ts; rep-funnel.ts date validation; tests/milestone06-rep-funnel.test.ts; tests/performance-report.test.ts.
Interfaces: consumes getRepFunnelReport(actor,filters,nowIso), ReportFilters, csvEscape; produces getPerformanceReport(actor,filters,nowIso): Promise<PerformanceReport>, performanceCsv(report): string and cohort conversion intersection helper.
1. Write failing tests for real invalid dates, conversion intersections, API snapshot metrics using existing seeded fixture: five submissions produce one unique deal; funded volume/commission reconciles event records, fees excluded; restricted finance and foreign membership fail closed.
2. Run targeted node test command. Expected: missing performance module / new real-date assertion FAIL.
3. Implement contracts and reports-only service, reuse funnel, query workspace-scoped funding/renewals/selected offers/payment tables; filter funding independently by event date; redact finances; date validation round-trip real YYYY-MM-DD.
4. Run tests. Expected: all targeted tests PASS. Commit reports service/tests.

### Task 2: Connect API, CSV and report UI
Files: nextjs-version/src/app/api/mca/reports/performance/route.ts; nextjs-version/src/components/mca/reports/performance.tsx; nextjs-version/src/app/(dashboard)/reports/page.tsx; targeted tests.
Interfaces: consumes Task 1 sanitized PerformanceReport; produces GET JSON or format=csv with identical filters/metrics.
1. Add API tests for role rejection, invalid basis/date/filter, CSV snapshot metric parity and finance omission. Expected: missing route FAIL.
2. Implement authenticated no-store GET; use existing rep-funnel actor; implement date/broker/basis inputs, metrics, definitions, pipeline and CSV download of displayed snapshot.
3. Run targeted tests, typecheck and lint. Expected: PASS, record baseline limitations by name. Commit API/UI.

### Task 3: Verify, review and draft PR
1. Parent coordinates full suite/build slot; execute approved aggregate command against disposable cluster and independent output directory. Expected: PASS or exact blockers captured.
2. Independent code reviewer assesses entire diff against spec; fix critical/important findings via regression tests.
3. Refresh graph per repository instructions; avoid committing unrelated generated graph artifacts. Commit evidence.
4. Push unique branch, create draft PR for user review, attach it; verify remote SHA and checks. No merge.

Review Focus: partial/void payment evidence, multiple committed funding dates, ambiguous selected revisions, foreign linked renewal rows, restricted JSON and CSV finance details, stale async report/filter changes.
Self-review: all scope items mapped; definitions explicitly distinguish recorded values from accounting policy; event/cohort denominators explicit. Date filters and attribution are consistent. No estimation calculation dependency duplicated.
