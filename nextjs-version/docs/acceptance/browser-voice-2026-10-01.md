# Browser Voice verification

Worktree: /Users/mbele/Documents/Codex/2026-09-30/task-4/fundlane-voice. Refreshed base3901e7e. Declared dependency stack: SMS53e7947→388c3f8→4ca987e; notifications fa14fe3→41a4264→10013c8. Voice draftPR213, never merged.

- `node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 tests/voice-*.test.ts tests/notifications.test.ts`:36/36 passed, including19 Voice and17 notification tests. Disposable local Postgres56544; tests create/drop unique databases, no hosted connections.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed,0 errors/16 preexisting warnings. Targeted Voice lint0 warnings.
- Independent implementation review: four findings reproduced RED→GREEN (dispatch permissions, post-disable outcome, late presence refresh, inbound replay terminal state).
- Independent narrow migration/Home review: Home guards preserved. Found db:secure overriding restricted migration grants; regression reproduced RED (`delete_calls=true`) →GREEN with table-specific runtime privilege helper. Test executes migration+actual securing script locally, verifies INSERT/SELECT/UPDATE and presence DELETE; denies RLS alteration, call-history DELETE and configuration TRUNCATE; then runs token/history/presence services over an actual restricted mca_app connection.
- Graphify updated/reclustered locally; generated artifacts omitted from feature commits because unified integration should rebuild the shared graph. HTML generation reports node-limit exceeded; source graph updated.

Full build/aggregate await parent resource allocation. Vercel preview status must be checked on final remote SHA; preview status does not prove Voice provider/audio acceptance. Hosted migrations/grants, credentials/number/application callback setup and notification runtime activation remain reviewed release gates. No live calls/microphone acceptance/provider provisioning/production mutations performed.
