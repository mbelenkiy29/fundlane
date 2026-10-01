# T6 verification evidence

Base:3901e7e8a41b72bd08177cbd0c7b5967d9a7cb09. Dedicated branch codex/t6-lender-fit-criteria. User scope: deterministic lender criteria/fit explanations; estimates consumes a read contract; brokers make final selection. No real rate sheets or criteria supplied.

Final targeted command (Node24.7.0, pnpm11.1.2):

```sh
MCA_TEST_DATABASE_ADMIN_URL=postgresql://t6_test@127.0.0.1:55446/postgres \
node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 \
tests/auto-submit.test.ts tests/funders-criteria.test.ts tests/funders-import.test.ts \
tests/funders-scan.test.ts tests/underwriting-analysis.test.ts tests/underwriting-scoring.test.ts \
tests/criteria-source-draft.test.ts tests/lender-fit.test.ts
pnpm typecheck
pnpm lint
```

63/63 tests,0 failures/skips. Typecheck pass. Lint0 errors/16 existing warnings. Each DB suite replays versioned migrations into uniquely named disposable databases and drops them. Standalone Postgres cluster on loopback55446, synthetic data only. Source/status tests use an explicit evaluation clock. HTTP tests cover read/write/intake scopes, wrong workspace, unassigned rep, no-store and no new scoring snapshot from a read.

Independent reviewer found worker fit-status bypass and scan editor date loss. Both corrected with RED→GREEN regressions and final targeted rerun. Actual worker checks missing source dates, future source dates and unknown soft inputs generate zero submission jobs; existing synthetic retry/kill-switch behavior remains exercised. Scan review/accept/rollback preserves unrelated dated criteria. Active/inactive/reactivated and post-score expiry invalidate actionable reads.

Graphify update and cluster-only completed; refreshed generated files retained locally under /tmp/fundlane-t6-graph-refresh because full graph rebuild rewrites unrelated thousands of lines. No generated graph diff included.

Outstanding gates: full aggregate suite and production build await exclusive parent allocation; hosted browser/auth acceptance; reviewed forward migration0074 and reconciliation of its main-based journal idx59 when combining feature branches; company admin collection of real lender source facts. No hosted migration, production access, live send, provision, credential/security change, Actions enablement or merge performed.
