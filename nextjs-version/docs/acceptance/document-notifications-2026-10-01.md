# T11 document notifications acceptance evidence

Worktree: `/Users/mbele/Documents/Codex/2026-09-30/task-10/fundlane-t11`.
Branch: `codex/t11-document-notifications-20261001`.
Verified refreshed main: `3901e7e8a41b72bd08177cbd0c7b5967d9a7cb09`.
Pinned notification prerequisite: `10013c80036048c9fa956c73ca2ce1b2c3daed45` (stacked dependency, migration0068 belongs to foundation).
T11 adds no migration, transport or scheduler and does not edit `documents/service.ts`.

## Verification

Disposable PostgreSQL17 loopback port55481, isolated harness databases, synthetic tenant/member/deal/document/link fixtures, provider overrides only.

- Pure facts TDD:5 failures →6 passing initial; category regression subsequently failed →fixed.
- Producer/API tests: unsafe template variables and input validation failed →fixed; broker policy independence failed →fixed.
- Independent review: two important findings, category mismatch and legacy unpersisted upload variables. Both reproduced with failing tests and fixed. Additional live republished-template regression failed →dispatch renderer fixed.
- Final focused command: `MCA_TEST_DATABASE_ADMIN_URL=postgresql://mbele@127.0.0.1:55481/postgres node --experimental-test-module-mocks --conditions=react-server --import tsx --test tests/document-notifications.test.ts tests/document-notification-facts.test.ts tests/document-notification-ui.test.ts tests/notifications.test.ts tests/milestone06-templates.test.ts tests/documents-core.test.ts` — **62/62 passed, 0 failed, 0 skipped**.
- Typecheck uses the checked local TypeScript executable (`node node_modules/typescript/bin/tsc --noEmit`), equivalent package script; shared dependency symlink avoided pnpm's attempt to replace another task's modules.
- Full lint uses checked local ESLint (`node node_modules/eslint/bin/eslint.js .`); final source **0 errors/16 existing warnings**, exit0. Focused lint is clean.
- Graphify AST refresh and cluster-only completed; refreshed outputs preserved at `/tmp/fundlane-t11-graph` rather than adding broad generated churn.
- Full aggregate and production build remain queued for the parent's exclusive slot. They are not claimed from targeted tests.

Covered: UTC month/year/leap/timezone boundaries; pending/ready/quarantine/failure; latest lineage; wrong company and same-company unassigned rep; revoked membership; concurrent dedup/original schedule/content conflict; resolved before dispatch; persisted link expiry/revocation/capacity; live optout and company policy; independent audience blocking; unknown-send evidence reconciliation; unknown guard fail-closed and standalone worker registration; authenticated API/CSRF/invalid input; UI queue and uncertain labels; template URL scope and live republish safety.

## Decisions and remaining gates

Existing closing request links were selected over old deterministic template links because persisted expiry/revocation is required. Statement boundary is explicit UTC and uses underwriting periods; no filename assumptions. Independent reviewer found no deferred minor issues. No periodic discovery sweep was introduced: event production is the explicit broker action/API; automated discovery is a separate integration requirement if desired. Parent-coordinated aggregate/build, exact remote/preview checks, hosted synthetic Auth/Storage and external provider/policy/consent activation remain separate gates. No merge or production mutation.
