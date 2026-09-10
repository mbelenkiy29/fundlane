# Milestone 02 Lane C cross-review

Reviewed 2026-09-08 against MIC-119, MIC-165, MIC-155, MIC-173, and MIC-167. This records the implementation boundary before Lane C applies the fixes sent during review. No live Google or model calls were made.

## Readiness at review boundary

| Ticket | Status | Evidence that passed | Work required |
| --- | --- | --- | --- |
| MIC-119 | Not ready | Real CSV/TSV/XLSX/XLS parsing, encoding/header handling, editable create mapping, workspace profiles, 1,000-row fixture, required business-name validation, row checkpoints/results CSV, and cancel-before-commit are implemented. | Recover stale `committing` runs; expose failed-run retry; persist explicit duplicate decisions rather than always skipping; add HTTP authorization evidence. |
| MIC-165 | Not ready | Multiple ZIP inventory, path/nested-archive/expansion limits, exact/ambiguous/unmatched matching, explicit row association, immutable document storage, and blank-only enrichment exist. | Make category editable and validate it server-side; add per-file recoverable results; retain specific enrichment provenance and review extracted values before applying. |
| MIC-155 | Not ready | Deterministic row-order pool assignment and active-member revalidation work; source and batch IDs reach intake provenance/results. | Map external rep names/IDs to active memberships with previewed precedence and a resolution UI. Current flow requires internal membership UUIDs in source cells. |
| MIC-173 | Not ready | Blank/cross-workspace IDs fail, owner/offer/payment targets are rejected, blank cells are no-op, explicit clears and expected versions exist, and status uses lifecycle transitions. | Expose editable update-column mapping and actual before/after values; close the two field/status checkpoint crash windows; provide retry UI. |
| MIC-167 | Not ready | Folder URL validation, real Drive v3 list/download calls, pagination, byte/time bounds, per-file denied/removed states, encrypted credential storage, explicit matching, and idempotent document keys exist. | Replace access-token paste with supported OAuth + user folder grant/Picker flow, verified scope and token refresh; resume from saved completed-file checkpoints instead of relisting/redownloading them; test live credentials separately. |

## Confirmed findings

1. A request/process crash leaves a create or update run in `committing`, but `beginCommit` accepts only `preview` or `failed`. No lease or recovery operation can resume it. Normal row errors reach `failed`, yet the UI disables commit as soon as any result exists, including a failed result.
2. CSV update changes fields before recording `updated_fields_pending_transition`. A crash in that interval makes the saved expected version stale with no checkpoint. A crash after the transition but before the final checkpoint can retry the transition even though it already happened. The retry path must reconcile both expected intermediate states.
3. Duplicate candidates have no persisted review decision. The UI only displays a warning and commit always skips rows with `duplicateDealIds`. There is no explicit create-anyway/skip/match control or preview-revision update.
4. `originatorMembershipId` values are validated directly as active internal membership IDs. There is no mapping from spreadsheet rep names/external IDs and no unresolved-name decision UI.
5. ZIP category is rendered as fixed text. Both ZIP and Drive confirmation bodies rely on TypeScript casts rather than runtime category validation, allowing an arbitrary category string to reach document storage.
6. The Drive UI asks an admin to paste a short-lived access token. It supplies no refresh token, expiry, or verified scope. The service defaults its recorded scope to `drive.file` and never refreshes. Google documents `drive.file` as per-file access selected through Google Picker/app picker, and its web-server OAuth flow exchanges a code and retains a refresh token. The present UI is a developer credential hook, not the ticket's supported authorization flow.
7. Drive transfer rows are recorded, but retries relist and redownload every confirmed file rather than using successful checkpoints. A removed file on retry can overwrite a prior downloaded result even though its document already exists.
8. MIC-173's service stores `before` and `changes`, but the UI renders only the names of changed fields. It also does not provide an editable update mapping. This is not a before/after change review.
9. Import routes are consistently session-only/admin and repository reads are workspace scoped. The focused import suite is service-level only, so the tickets' direct-request authorization criterion lacks demonstrated HTTP coverage. Staged rows retain every source cell in plaintext `source_values_json`, including unmapped columns, without a retention/cleanup policy; production handling should minimize or encrypt that temporary data.

## Required regression evidence

- Recover a stale commit after created-row and update-field/status interruption points without duplicate side effects.
- Review and persist duplicate create/skip/match choices and external-rep resolution; revalidate revision and memberships at commit.
- Edit ZIP/Drive categories and reject invalid direct JSON categories.
- Show update header mapping and actual old/new/clear values before commit.
- OAuth start/callback/state, Picker/folder grant, refresh, expired/revoked token, per-file denied/removed, and completed-file resume fixtures; record live end-to-end as an external gate until credentials exist.
- Direct HTTP session/role/workspace/CSRF checks for registry, preview/status/cancel/commit, archive, update, and Drive routes.

## Post-fix resolution

Re-reviewed 2026-09-08 after Lane C remediation. The focused import suite passed **15/15** with `tests/imports-core.test.ts` and `tests/imports-http.test.mjs`; no live Google Drive or model calls were made.

All review findings are closed:

1. Import runs now use expiring commit leases and per-attempt tokens. Row checkpoints and finalization compare the active token, so a reclaimed worker cannot overwrite the new worker's state. Create retries retain stable intake identity.
2. Bulk field and lifecycle updates now use one version-checked deal write. The deal mutation and import-row checkpoint execute in the same `BEGIN IMMEDIATE` transaction; a reclaimed worker's stale token aborts and rolls back the deal mutation. The exact stale-token interleaving regression proves the merchant name and version remain unchanged.
3. Duplicate candidates require a persisted create-or-skip review decision and increment the preview revision before commit. The earlier request for a match-existing mode is withdrawn: MIC-119 requires duplicates to be shown with explicit create review, not a separate match-existing action.
4. External originator values resolve through saved workspace mappings, unresolved values remain blocked for review, and active membership is revalidated at commit.
5. ZIP and Drive associations expose editable categories, validate categories at the service boundary, retain per-file results, and preserve specific enrichment provenance while filling only blank fields.
6. Drive setup uses OAuth authorization state, offline access, verified read scope, refresh-token handling, folder verification, actionable expiry/revocation behavior, and clean disconnect/revocation.
7. Successful Drive transfer checkpoints are immutable. A resumed request returns completed files before credential lookup, folder listing, or download, while unfinished files remain retryable. The no-credential/no-fetch regression also proves a later removed/error result cannot replace a completed checkpoint.
8. CSV updates expose editable header mapping plus actual before/after/clear values and a retryable run state.
9. Import routes have direct HTTP coverage for session/admin enforcement, CSRF, workspace scope, reviewed create/update replay, and category validation. Staged source/application values are encrypted at rest and remain admin-session only at the service boundary.

### Ticket recommendation

| Ticket | Recommendation | Evidence boundary |
| --- | --- | --- |
| MIC-119 | Done | Real spreadsheet formats, 1,000-row fixture, editable/reusable mapping, explicit duplicate review, cancellation, checkpoints, stale-lease recovery and HTTP authorization pass locally. |
| MIC-165 | Done | Archive safety, exact/ambiguous/unmatched review, editable validated categories, confirmed immutable storage and blank-only enrichment provenance pass locally. |
| MIC-155 | Done | Stable round robin, explicit originator precedence/mapping, batch/source provenance and active-member revalidation pass locally. |
| MIC-173 | Done | Workspace/version safeguards, editable mapping, before/after/clear review, atomic field/status mutation, token-fenced checkpointing and completed replay pass locally. |
| MIC-167 | Done | OAuth/refresh/revoke fixtures, Drive limits and error states, immutable resumable checkpoints, stable document identity and HTTP authorization pass locally. |

Live Google credential validation remains an external production-readiness check. It is recorded separately from the completed local implementation and synthetic contract evidence.
