# CRM detail lifecycle audit spec

Scope: reuse existing import, assignment, contacts, notes, pipeline stages/history and action queues. Fix concrete pipeline UI lifecycle defects only; no server/schema/permission changes, provider activation, sends or new client stage policy.

Audit finding: list requests already use request generations and expose loading/empty/error/retry. Detail requests have no generation guard, dismiss errors without retry, and retain note/status/conflict/form state across selections. A late detail or mutation response can show a previously opened deal.

Design: a small browser-only detail session owns the current requested deal, load state, note/status drafts, and request identity. Opening/retrying clears selection drafts, exposes loading, then success or an inline retryable error. Closing invalidates pending work. Only the current selection session may apply async UI results; refreshing a detail must also avoid regressing its version. Existing server optimistic version checks remain authoritative. Mutation requests already issued still complete server-side when the dialog closes; their responses must not replace a later selection.

Role assumption: company owner is existing admin/super_admin, broker is existing assigned rep, restricted role is an unassigned rep. Preserve existing role semantics and stage defaults from deals/pipeline.ts; stage configurability is not claimed or introduced. No external dependency or shared schema/API change.

Acceptance: controlled out-of-order loads/errors and close/reopen cannot replace current detail; note/status drafts reset across selections; active errors support retry; stale mutations cannot affect a new session. One synthetic spreadsheet import assigns a rep; that rep changes lead→new_application and adds a note; history records both; unassigned and foreign-company actors cannot read/change/note/reassign the deal. Invalid stage, incomplete submission, stale version and assignment escalation must leave records intact. Existing queues remain reused, no provider sends or queue feature expansion.
