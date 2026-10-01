# T0 Acceptance Foundation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reproduce local synthetic tenant/document/job and DB-plus-byte recovery evidence.
**Architecture:** Reuse existing service suites and isolated migrated Postgres helper. A test-only AES-GCM envelope carries real pg_dump bytes plus document bytes; restore checks use existing restoreDrill and document services.
**Tech Stack:** Node 24, pnpm 11.1.2, TypeScript/node:test, PostgreSQL 16+.
**Spec:** docs/superpowers/specs/2026-10-01-t0-acceptance.md

## Global Constraints
No hosted mutation, communications, cloud provisioning, shared auth/schema/scheduler edits. Synthetic data only. Unique loopback port and database names. Coordinate full build/aggregate with parent.

## Review Focus
- Wrong archive key/tampering must fail before SQL restore.
- Missing/corrupt document bytes must fail acceptance despite relational integrity.
- Restored quarantine must stay unreadable; cross-tenant and restricted actors remain denied.
- Recovery must preserve deal, membership and financial references.
- Cleanup must drop only databases created by this run and stop only its cluster.

### Task 1: Recovery integration proof
**Files:** Create tests/acceptance-foundation.test.ts; modify src/lib/mca/documents/service.ts only for proven byte-read integrity defect.
**Consumes:** createPostgresTestDatabase, storeDocument/getDocumentContent, FilesystemDocumentStorage, restoreDrill, verify-restore.sql.
**Produces:** node:test proof and sanitized diagnostics, no runtime API.
- [x] Write integration assertions for real encrypted pg_dump + private file restore, wrong key/tampering, missing/corrupt bytes, quarantine and tenant/role denial.
- [x] Run RED to expose missing proof helper/fixture.
- [x] Implement test-only bundle encryption/decryption and synthetic linked fixture; use existing operational SQL restore.
- [x] Run targeted proof GREEN and existing document/job/backup suites.
- [x] Commit test with evidence (51b7076).

### Task 2: Local reproducibility and acceptance matrix
**Files:** Create nextjs-version/scripts/ops/local-acceptance.sh and nextjs-version/docs/acceptance/t0-local-foundation.md.
**Produces:** isolated cluster runner and exact runbook commands/limits.
- [x] Add fail-closed runner with task-owned temporary cluster/port and cleanup trap, clearing external app credentials by invoking tests with a minimal environment.
- [x] Run bash syntax check and scoped runner. Expected: all named tests pass, sanitized diagnostics and clean cluster shutdown.
- [x] Document actual evidence, test-to-criteria mapping, local-vs-hosted gaps and restore/key procedures.
- [ ] Coordinate final type/lint/build/aggregate with parent, request independent review, resolve substantive findings, publish draft PR and verify head/checks.

## Self-review
Scope and interfaces match existing modules; no new production backup format or scheduler ownership. Hosted acceptance remains explicitly blocked. User supplied plan-and-execute authorization: proceed after recording this design and self-review without redundant confirmation.

## Execution ledger
Ruling: real process SIGKILL added beyond simulated lease fixtures; disposable lease clock advanced to bound runtime, not a production timing claim.
Ruling: scoped byte-read integrity fix added after restore test reproduced corrupted content release; no shared auth/schema change. Cost if wrong: download callers see recoverable 409/503 rather than bytes.
Ruling: native worktree creation tool could not identify this projectless task repository; git worktree add used with explicit user isolation authorization.

Task 1: scoped runner 58/58 pass, 0 skipped; checksum regression RED→GREEN, literal SIGKILL pass. Typecheck and focused lint pass.
Task 2: runner bash syntax and lifecycle pass; explicit C locale and short socket path required for macOS.

Final review: independent reviewer t0_review identified P2 failed-start cleanup. Fixed startup tracking and retention; cleanup regression RED→GREEN, scoped suite 60/60. No deferred minors or rejected findings.

Task 2: draft PR211 published; runtime/test final scoped suite60/60, typecheck pass, full lint0errors16existing warnings. Aggregate/build remain explicitly queued with parent, Vercel check pending. Generated graph refreshed locally, omitted from narrow feature PR.
