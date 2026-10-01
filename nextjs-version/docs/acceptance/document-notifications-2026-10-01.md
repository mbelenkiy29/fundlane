# T11 document notification acceptance evidence

## Delivered behavior

Manual document alerts and configured automatic discovery use the notification foundation. Explicit company administrator approval records a server timestamp, live approver and incrementing version. Existing automation is off; merchant automation needs dedicated document approval, configured cadence/channel/template/sender and actual current consent. Discovery reads existing missing/requested/stale conditions, active assigned originator/closer recipients, and persisted scoped request links. No requirements API, transport, consent wording or scheduler is introduced.

A bounded company lease and keyset cursor retain partial deal/item progress and reset at the next cadence occurrence. Worker hook maximum20 event attempts/10 deals, discovery14s work plus1s cleanup, shared delivery budget retained. Active approval, reasons, assignment, document condition, scoped link, consent and optout are checked again before dispatch. Unknown outcomes block automatic new identities and suppress already queued automatic occurrences until reconciliation.

## Verification

- Final focused run: `MCA_TEST_DATABASE_ADMIN_URL=postgresql://mbele@127.0.0.1:55481/postgres node --experimental-test-module-mocks --conditions=react-server --import tsx --test tests/document-notifications.test.ts tests/document-notification-facts.test.ts tests/document-notification-ui.test.ts tests/notifications.test.ts tests/milestone06-templates.test.ts tests/documents-core.test.ts` — **82/82 passed,0failed,0skipped**. Fresh disposable databases and synthetic fixtures only.
- `node node_modules/typescript/bin/tsc --noEmit` — exit0. Shared dependency symlink retained rather than allowing pnpm to replace another task's modules.
- `node node_modules/eslint/bin/eslint.js .` — exit0,0errors/16existingwarnings.
- Graphify AST refresh and cluster-only completed:14898nodes/46977edges,719communities.31unsupported/empty sources noted; HTML skipped at configured5000node limit. Outputs preserved under `/tmp/fundlane-t11-final-graph` without broad generated changes in the PR.
- Independent read-only reviewer re-reviewed automatic configuration/API/UI/migration/discovery/runtime hook. All important findings fixed; final reviewer reports none remaining.
- Regression RED/GREEN evidence: removed admin assignment originally allowed4sends, now0; locked cursor cleanup originally waited2.7s, now returns within1s and leaves recoverable lease; queued cadence backlog originally sent3times after unknown first outcome, now1send and suppression. Earlier review fixes cover linked document category mismatch and legacy upload variable republishing.

Covered: UTC month/year/leap/timezone boundaries; scan safety/latest lineage; wrongcompany/role/access; durable approval/version/defaultoff; forged approval/cadence/origin API denial; assigned recipients/no arbitrary broadcast; bounded cap/cursor/tenant fairness; concurrent ticks/lease recovery/fencing; runtime off/deadline stop; repeated-event identity/original approval; resolved conditions, expired/revoked/consumed/foreign links, disabled policy/approver, consent/optout; guarded renderer; uncertainty and reconciliation; configuration readiness labels.

## Dependencies and remaining gates

Exact foundation pin `1e56cc77b1ca5a5568e36cb4d7cd91e17a5fde27`, draft PR212. T11 owns the sole document guard registration and discovery call in the worker plus fixed2field document template extension. No documents/service.ts edits.

Reserved `0073_document_notification_discovery.sql` is journaled at index 64 (`when` 1790819000072) after notification foundation `0071` at index 62 (`when` 1790385600020, PR #212). Browser voice `0072` is on separate PR #213; integration must reconcile its journal entry at index 63 (`when` 1790385600021) before production applies `0071`, `0072`, then `0073`.

Aggregate tests and production build remain queued for the parent's exclusive slot and are not claimed from targeted tests. Parent status messages were attempted but the desktop bridge returned an error; final task handoff carries this evidence. Remote draft head/checks are recorded in the task handoff. Hosted synthetic Auth/Storage, hosted migration, safe application origin, sender/provider readiness, actual consent and runtime activation remain release gates. No external activation, production mutation, live communication or merge occurred.
