# MIC-120: historical CSV re-upload

## Problem and behavior

Supabase audit records for the reported customer showed a 25-row valid preview followed by a 25-duplicate preview. Neither run had been committed. Preview persistence had reserved the external IDs.

Previews now store every row independently. Only rows with outcome `created` reserve `(workspace_id, source_id, external_id)`. Repeated IDs within a file remain duplicates. Fresh uploads, including corrected files and uploads with the same batch label, are validated again. Existing funded identities are skipped even when uploaded values differ; importing never edits their financial history.

The preview API accepts optional `requestId` (1–160 characters). A workspace-scoped key and a hash of parsed input provide transport idempotency. Identical retries return the saved run; changed input with the same key returns 409. Object key ordering does not affect the hash. Batch labels are descriptive. Requests without a key always create a new run. Both import interfaces retain a key after a failed request and generate a fresh key after successful preview or changed inputs.

Commit acquires identity locks in consistent order before financial writes, rechecks completed rows, and records concurrent winners as duplicates. The existing funding-event idempotency constraint and a partial unique index on created historical rows provide database enforcement. Retries of partially failed runs retain that run's successful results and skip rows completed by another run.

## Migration

`0038_historical_preview_identity.sql` adds nullable request ID/input hash columns, replaces batch uniqueness with workspace/request uniqueness, and replaces global preview-row identity uniqueness with uniqueness restricted to created rows. Run/row-number uniqueness remains intact. No existing import or financial rows are deleted or rewritten. Existing previews that omitted duplicates cannot reconstruct those missing row details; a fresh upload supplies them.

Migration numbering follows the current production branch, which already contains `0037_platform_status`. The shared local checkout predates that unrelated migration; the isolated release checkout contains the complete production migration journal plus 0038.

## Validation

- Disposable local PostgreSQL: abandoned 25-row uploads, same/different batch labels, corrected invalid rows, saved duplicate-row reload, request-key retries/conflicts, timeout rollback, workspace/source isolation.
- Financial integration: simultaneous commits in opposite row orders create one event/advance/commission per identity; partial failures can be completed by a fresh upload without replaying prior funding; original dates and paid commission are preserved.
- Migration upgrade fixture: pending, invalid and created legacy rows survive; pending identity overlap is allowed; duplicate created identities and reused request keys remain constrained.
- Actual Next.js HTTP routes with a local Supabase protocol fixture: multipart CSV upload, fresh JSON preview, request replay, 409 conflict, 422 malformed request, 401 without authentication, commit 25 rows, re-upload showing 25 already-imported rows.
- Shared checkout typecheck and production build pass. Targeted ESLint passes. Repository-wide lint has pre-existing errors/warnings, primarily generated Supabase runtime bundles; it is not a clean release signal.

## Coordinated production rollout

The user selected the existing `fundlane` production project rather than provisioning hosted staging. Synthetic end-to-end verification uses the isolated local database and actual Next.js HTTP routes.

Migration 0038 locks both historical tables transactionally, draining existing writers, then installs statement triggers requiring transaction setting `mca.historical_writer=2`. Updated preview/commit handlers set that value. Old deployment handlers cannot mutate either table, including when reached through stale URLs. A lock timeout aborts the migration without partial changes; retry after existing imports finish. The compatibility gate remains after promotion.

1. Build the isolated release from production commit `22ad1ce`, with only this fix. Prepare a production-target deployment without assigning domains.
2. Verify local regression, migration and HTTP checks; apply 0038 to project `drubsfvhlggmtyiigwxy` using Supabase's migration transaction. Immediately promote the prepared deployment. During the interval, old import writers are blocked; other workflows remain available.
3. Verify the deployment alias, version-gate triggers, partial unique index, request columns, preserved customer previews, and runtime import errors. The customer can re-upload without changing external IDs or deleting the earlier preview. Commit remains explicit.
4. If promotion fails, leave the compatibility gate in place and fix forward. Never restore the old uniqueness constraints over overlapping previews or permit old writers against the new schema.

Production's existing Drizzle ledger stops at 0036, while the already-deployed source contains an unapplied, unrelated 0037 platform-status migration. Register 0038 in Supabase's migration ledger; do not advance the Drizzle timestamp past the unrelated pending migration. 0038 is replay-safe so the checked Drizzle runner can apply it after that gap is reconciled separately.

Production rollout results will be recorded below after verification.
