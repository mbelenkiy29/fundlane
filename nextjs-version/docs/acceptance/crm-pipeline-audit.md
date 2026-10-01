# CRM pipeline audit (2026-10-01)

Base: `3901e7e8a41b72bd08177cbd0c7b5967d9a7cb09`. Scope is the existing `/pipeline` brokerage flow, not a CRM replacement. Design and implementation plan are in `docs/superpowers/{specs,plans}/2026-10-01-crm-detail.md` at repository root.

## Concrete change

Detail selections now own their asynchronous results. Slow loads/errors and completed mutations from a closed or replaced selection cannot replace the current deal, including closing/reopening the same deal. Refresh responses cannot roll the displayed record back to an older version. Opening a detail clears the previous note, transition, conflict, validation errors and edit form. An active detail-load error stays in the dialog with Retry. Document/workflow refresh keeps the current selection and drafts.

Already issued server mutations still finish when the user closes the dialog; the UI discards their obsolete completion. Server `expectedVersion` conflict protection remains unchanged. Drafts are not durable: closing/reopening or changing selection clears them. This matches the selected-deal scope; persistent note drafts are not introduced.

## Existing modules reused

- Spreadsheet preview/review/commit assigns existing memberships; stable import retry/checkpoints are unchanged.
- Deals service/repository own workspace scoping, assignment hierarchy, contacts, field provenance, notes, stage validation, optimistic versions and history.
- Table and Kanban use the same filtered deal set and counts. List loading, filtered/unfiltered empty, load error and Retry states already exist.
- Submission reply queue, calendar, offers/closing, documents, underwriting and assistant panels stay integrated. Queue transport/provider execution is outside this UI audit and is not claimed verified by these tests.

Owner means the existing `admin`/`super_admin` company role, broker means an assigned `rep`, and restricted means an unassigned `rep`. No new role or authorization rule. Pipeline status labels and legal transitions remain the existing defaults in `deals/pipeline.ts`; client stage policy/configurability was not supplied and is not invented.

## Verification

Node 24.7.0, pnpm 11.1.2, unique loopback PostgreSQL 16 port 56416. Tests create/drop randomly named disposable databases; no production data, provider sends, credentials or hosted changes.

- Nine deterministic detail-session tests: out-of-order success/failure, close/reopen, failure/retry, draft clearing, old mutation guard, version ordering, stable store subscription, child callback session binding, initial-load/version ordering and Assistant handoff.
- Synthetic journey in `tests/imports-core.test.ts`: one CSV import → originator assignment → assigned broker `lead` to `new_application` → internal note → stage/note history; contact/provenance and idempotent replay checked. Unassigned rep and foreign-company admin reads/updates/transitions/notes reject; foreign assignment/hierarchy escalation, illegal stage, incomplete submission and stale note versions reject without version changes.
- Targeted suite: `node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 src/lib/mca/deals/acceptance.test.ts tests/crm-detail-session.test.ts tests/imports-core.test.ts tests/deals-http.test.mjs` — 40 passed, 0 failed.
- `pnpm typecheck` — passed. `pnpm lint` — exit 0, with 16 warnings in unchanged files and no errors.

Independent reviewer identified Assistant context clearing and child workflow token capture/version ordering as Important findings. Both were corrected; the new initial-load ordering test reproduced the failure (v1 overwrote v2) before the fix and now passes. Assistant handoff has its own failing-then-passing lifecycle test. Final aggregate/build results will be recorded after their coordinated runs.

## Remaining acceptance

Detail-store tests execute the actual lifecycle logic; they are not an end-to-end browser test of the React dialog wiring. Verify two synthetic deals in a safe preview: slow detail A then B, open/close during a pending save, note/status drafts when switching deals, offline detail error/Retry, and keyboard/screen-reader dialog behavior. Hosted Supabase Auth/Storage and provider-backed action queues need their own staging acceptance. No external activation is added by this branch.
