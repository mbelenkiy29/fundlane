# Notification foundation local evidence

Branch `codex/notification-foundation-20261001`, base `3901e7e8`; draft PR #212. Isolated repository/worktree under `2026-09-30/task/fundlane-notification-repo` and `fundlane-notifications`. Node24.7.0, pnpm11.1.2. Dedicated disposable local PostgreSQL port55471; each suite creates/drops its own synthetic database. No live provider sends or production data/settings.

Final source verification:

- `node --experimental-test-module-mocks --conditions=react-server --import tsx --test tests/notifications.test.ts tests/system-email.test.ts tests/email-conversations.test.ts tests/milestone05-sms.test.ts tests/milestone06-followups.test.ts`: **61 passed, 0 failed**. This includes **18 notification tests**.
- `pnpm typecheck`: pass.
- `pnpm lint`: exit0, zero errors, 16 existing warnings in unrelated modules/tests.
- Migration history including0068 replayed successfully by disposable test harness. Drizzle model/config/journal and runtime append-only receipt grants accompany SQL.
- Graphify AST update and cluster refresh ran locally; 31 zero-node JSON input warnings and graph HTML skipped at its5000-node threshold. Generated graph changes stay local, outside the feature diff.

RED/GREEN evidence: initial service module missing; worker module missing; unsubscribe export missing; provider receipt lookup export missing; condition module missing; receipt polling starvation (`1 !== 2`); exhausted shared runtime budget dispatched incorrectly (`1 !== 0`). Each respective implementation passed its regression. Final fixtures cover wrong-company references/reads, live broker recipient access, policy/consent defaultoff, concurrent duplicate identities, original merchant approval vs internal broker notifications, revoked SMS consent, suppression/unsubscribe, transactional rollback, sanitized receipts, token fences, killed/unknown sends, bounded retries, no-replay reconciliation, rotating provider reads, live resolved conditions and defaultoff runtime.

Required remaining gates: independent reviewer assigned by parent; aggregate `pnpm test` and `pnpm build` queued for parent-controlled execution slot. Provider/hosted acceptance, restricted runtime grants, comms scheduler ownership, document guard/bootstrap and allowlisted persisted link renderer integration remain release gates. No result above proves hosted delivery or production readiness.
