# Client SMS integration verification

Base: `3901e7e8a41b72bd08177cbd0c7b5967d9a7cb09`. Branch: `codex/client-sms-readiness`.

## Functional changes

Existing managed Twilio transport, provisioning, consent and inbox remain the owners. `sms/number-ownership.ts` exports the server-only `getCompanyNumberOwnership(workspaceId, numberId)` contract: number/account/provider IDs, phone/state, assignment activity, company suspension and credential-presence metadata. Missing/foreign numbers return absent. Callers authorize workspace access first. Existing `sms/onboarding.ts` `company` and `provider` resolve credentials only on the server. Voice owns its independent capabilities and activation checks; SMS registration does not establish Voice readiness.

`managedReadiness` produces redacted blocker codes/messages shared by managed accounts and onboarding number status; the existing boolean `managedReady` remains compatible. Settings and composer render actual blockers. Connection status uses number readiness where supplied.

Inbox refresh checks context at both asynchronous boundaries. Reply drafts retain exact text/key across uncertain outcomes and thread switches; known first-attempt pre-dispatch rejection can unlock editing, while rejection of a previously uncertain retry cannot. Confirmed provider failure permits an explicit new draft. Unsupported signed opt-out types are rejected before persistence. Concurrent retries serialize the local message reservation and dispatch once; this adds no retry scheduler.

## Evidence

- Existing baseline SMS suite: 40/40 passed.
- Final focused suite: 67/67 passed against disposable PostgreSQL on `127.0.0.1:55443`; databases use random test names and are dropped by the harness. Synthetic provider traffic only.
- Command: `node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 tests/sms-onboarding.test.ts tests/milestone05-sms.test.ts tests/milestone06-sms-composer.test.ts tests/sms-adapters/twilio.test.ts tests/sms-reply-draft.test.ts tests/sms-readiness.test.mjs tests/sms-cron.test.ts tests/integration-status.test.ts` with local `MCA_TEST_DATABASE_ADMIN_URL`.
- `pnpm typecheck`: passed. `pnpm lint`: zero errors, 16 existing warnings outside changed SMS files.
- Red→green regressions cover sender-number mismatch, malformed origin, absent/foreign ownership, unsupported callback persistence, immutable uncertain drafts, read acknowledgement after context change, definitive rejection recovery and concurrent retries.
- Independent GPT-6.1 Sol medium reviewer reviewed `3901e7e..388c3f8` read-only. Two Important findings (stale read acknowledgement and locked pre-dispatch rejection) were fixed with focused regressions; no deferred minor findings.
- Graphify update and cluster-only completed. Whole-graph regeneration changes hundreds of thousands of generated lines; refreshed output is retained separately under `/tmp/fundlane-sms-graph`, excluded from this focused feature PR.
- Aggregate `pnpm test` and production build await the parent's exclusive verification slot. They have not been claimed as passing.

## Dependencies and remaining gates

No migration, credential/grant change or provider provisioning. Notification foundation pin `41a4264` already reuses `deliverClosingSms`; no adapter hook or scheduling dependency is required here. Shared-file change is limited to SMS logic in `integrations/connection-status.ts`; email logic remains intact.

Issue [#42](https://github.com/mbelenkiy29/fundlane/issues/42) external activation stays open. Real traffic eligibility, company/carrier approvals, new-number purchase, Advanced Opt-Out console confirmation, callback installation and authorized controlled pilot remain human/provider gates. This task did not buy numbers, submit A2P, configure credentials, send real messages, mutate hosted data, enable Actions or merge.

No hosted/browser acceptance is claimed from local fixtures. Draft persistence is component-memory only; reload recovery and live reconciliation still require controlled product acceptance.
