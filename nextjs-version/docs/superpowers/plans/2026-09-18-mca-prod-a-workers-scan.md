# MCA Prod A — Workers, Scan, Production Gates

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Follow the **master plan** for migration numbers and file ownership.

**Goal:** Deal vault documents fail closed until scan is `clean`; Vercel enqueues `document_scan` and `submission_delivery`; the Render document worker claims them and heartbeats; invitation email / SMS / live Stripe / Google Calendar stay fail-closed with honest copy.

**Architecture:** Keep `backgroundJobsEnabled()` true on Vercel. Durable work is a `mca_background_jobs` row. Render `scripts/workers/run.ts` is the consumer. Edge documents handler stays 503. Create `src/lib/mca/submissions/delivery-job.ts` here; Team C extends it.

**Tech Stack:** Next.js 16, Postgres jobs, Render workers, Cloudmersive/ClamAV, Supabase Storage.

**Spec:** `2026-09-18-mca-prod-master.md`

## Locked decisions

- No `malwareScanPerformed: false` ready path in `completeDocumentUpload`.
- Historical `ready` remains usable (`isDocumentReady` = `ready` | `clean`).
- Do not enable invitation email, SMS ISV, live Stripe, Google Calendar.
- Do not rotate `MCA_DATA_ENCRYPTION_KEY`.
- Do not change `processJobDelivery` sending-resume (Team C).
- Migration is **`0040_document_worker_heartbeat.sql`**, not 0040-from-other-teams.

## File map

| File | Role |
| --- | --- |
| `src/lib/mca/documents/scanner.ts` | Select Cloudmersive / ClamAV / unconfigured |
| `src/lib/mca/documents/service.ts` | Scan then promote; enqueue `document_scan` on Vercel |
| `src/lib/mca/submissions/delivery-job.ts` | **Create.** System actor + enqueue `submission_delivery` |
| `src/lib/mca/submissions/queue.ts` | Enqueue delivery when jobs enabled; inline when not |
| `src/lib/mca/jobs/worker.ts` | Recover outbox via enqueue; heartbeat |
| `scripts/workers/run.ts` | Heartbeat + recover each tick |
| `drizzle/0040_document_worker_heartbeat.sql` | `ops_control.document_worker_heartbeat_at` |
| `src/lib/mca/operations/{contracts,monitor}.ts` | Lag metrics |
| `src/app/api/internal/health/route.ts` | `workerReady` |
| `src/components/mca/operations/status-dashboard.tsx` | Heartbeat tile |
| Tests | `documents-core.test.ts`, `cloudmersive.test.ts`, `jobs-worker.test.ts`, `platform-status.test.ts`, `application-outreach.test.ts`, `edge-runtime.test.ts` |

## Task 1: Wire Cloudmersive; unconfigured fail-closed

**Files:** `scanner.ts`, `service.ts` (`scannerConfiguration` copy), `tests/cloudmersive.test.ts`

**Produces:** `documentScanner()` returns `CloudmersiveScanner` when `MCA_DOCUMENT_SCANNER=cloudmersive`. Unconfigured scan status `unavailable`.

- [ ] Test: unconfigured → `unavailable`; `cloudmersive` without key → `unavailable`; with mode set → `name === "cloudmersive"`.
- [ ] Run: `node --experimental-test-module-mocks --conditions=react-server --import tsx --test --test-concurrency=1 --test-name-pattern="documentScanner selects Cloudmersive" tests/cloudmersive.test.ts`
- [ ] Implement factory; keep ClamAV branches.
- [ ] Commit: `fix(documents): wire Cloudmersive scanner and keep unconfigured fail-closed`

## Task 2: Deal vault fail-closed scan

**Files:** `documents/service.ts`, `tests/documents-core.test.ts`

**Produces:** `completeDocumentUpload` maps scan → `clean` | `quarantined` | `scan_failed` | `pending_scan`. Promote only on `clean`.

```ts
function scanState(result: ScanResult): DocumentProcessingState {
  return result.status === "clean" ? "clean"
    : result.status === "infected" ? "quarantined"
    : result.status === "error" ? "scan_failed"
    : "pending_scan"
}
```

- [ ] Rewrite `"vault uploads without a scanner..."` → fail closed until clean. Rewrite `"all deal categories become ready without invoking the configured scanner"` → scanner must run. MIC-169 / promotion tests expect `clean` not skip-scan `ready`.
- [ ] Delete `VERCEL` / `MCA_BACKGROUND_JOBS` in this suite so scan is inline.
- [ ] Implement. Do not enqueue yet.
- [ ] Run full `tests/documents-core.test.ts`.
- [ ] Commit: `fix(documents): fail closed on deal vault malware scan`

## Task 3: Enqueue `document_scan` on Vercel

**Files:** `documents/service.ts`, `tests/jobs-worker.test.ts` (create)

**Produces:** HTTP `storeDocument` with jobs enabled returns `pending_scan` and a queued `document_scan` row; `runNextBackgroundJob` promotes to `clean`. Direct uploads inside `runAsBackgroundWorker` still scan inline.

- [ ] Test: jobs enabled → 0 scans in HTTP, 1 after worker.
- [ ] Before `documentScanner().scan`, if `backgroundJobsEnabled() && !inBackgroundWorker()`, set `pending_scan` and `enqueueBackgroundJob({ kind: "document_scan", resourceId, idempotencyKey: \`document_scan:${id}\` })`.
- [ ] Commit: `fix(documents): enqueue document_scan on Vercel instead of scanning in-request`

## Task 4: Test/docs/UI fallout

**Files:** `docs/deal-document-uploads.md`, `document-panel.tsx`, `merchant-upload-panel.tsx`, any test asserting `"ready"` after `storeDocument`.

- [ ] `pnpm test` — fix assertions to `isDocumentReady` / `"clean"`. Do not restore skip-scan.
- [ ] Copy: Scanning / Scan failed / Blocked. Success: “Malware scan is pending” when not ready.
- [ ] Commit: `docs(ui): deal vault fail-closed scan copy and test fallout`

## Task 5: Create delivery helper + enqueue `submission_delivery`

**Files:** create `submissions/delivery-job.ts`; modify `submissions/queue.ts`, `submissions/repository.ts` (persist confirming actor on outbox payload); `tests/jobs-worker.test.ts`

```ts
export function submissionDeliveryActor(job: { workspaceId: string; dealId: string; id: string }): DealActor {
  return {
    workspaceId: job.workspaceId, userId: null, membershipId: null, role: null,
    managedMembershipIds: [], activeMembershipIds: [], source: "system",
    intakeDealId: job.dealId, correlationId: job.id,
  }
}
export async function enqueueSubmissionDelivery(job: { workspaceId: string; dealId: string; id: string }): Promise<void>
```

- [ ] When `backgroundJobsEnabled()` and new job `state === "queued"`, enqueue instead of `processJobDelivery`. When jobs disabled, keep inline so `tests/submissions-core.test.ts` stays green.
- [ ] Commit: `fix(jobs): enqueue submission_delivery instead of inline send on Vercel`

## Task 6: Recover outbox + heartbeat

**Files:** `jobs/worker.ts`, `scripts/workers/run.ts`, `drizzle/0040_document_worker_heartbeat.sql`, journal idx 37 tag `0040_document_worker_heartbeat`

```sql
ALTER TABLE mca_private.ops_control
  ADD COLUMN IF NOT EXISTS document_worker_heartbeat_at timestamptz;
```

- [ ] `recoverSubmissionOutbox(): Promise<number>` enqueues missing `submission_delivery` via `enqueueSubmissionDelivery`. Actorless legacy rows: log only.
- [ ] `touchDocumentWorkerHeartbeat()` every worker tick including idle.
- [ ] Tests: enqueue count 1 then 0; heartbeat written.
- [ ] Commit: `fix(jobs): recover submission outbox and heartbeat the document worker`

## Task 7: Surface worker lag

**Files:** `operations/contracts.ts`, `monitor.ts`, `api/internal/health/route.ts`, `status-dashboard.tsx`, `tests/platform-status.test.ts`

```ts
export function documentWorkerReady(metrics: { documentWorkerHeartbeatAgeSeconds: number | null }): boolean {
  return metrics.documentWorkerHeartbeatAgeSeconds != null && metrics.documentWorkerHeartbeatAgeSeconds <= 90
}
```

- [ ] Metrics + incident `document_worker`. Health `workerReady`. Dashboard warning: “Document worker has not claimed work recently.”
- [ ] Do not fail website health solely on lag.
- [ ] Commit: `feat(ops): surface document worker lag on health and admin status`

## Task 8: Honest fail-closed copy

**Files:** `applications/service.ts` (`invitationEmailEnabled`), applications GET + UI, calendar workspace, credit-balance, `tests/application-outreach.test.ts`

- [ ] Production without `MCA_APPLICATION_INVITATION_EMAIL_ENABLED=true` → Send disabled, “copy the link”.
- [ ] Calendar: “Google Calendar sync is not running in this environment.”
- [ ] Credits: do not say “Buy a credit pack” unless `purchasesAvailable`.
- [ ] Do not flip env flags.
- [ ] Commit: `fix(ui): honest fail-closed copy for email, calendar, and credits`

## Task 9: Edge documents stay 503

**Files:** `tests/edge-runtime.test.ts`, `docs/render-deployment.md`

- [ ] Characterization test: `edgeWorkerHandler("documents")` → 503 `document_migration_incomplete`.
- [ ] Docs: processing not live until a Live worker deploy shows a fresh heartbeat.
- [ ] Commit: `test(docs): keep Edge documents fail-closed and record worker recovery gates`

## Task 10: Wave verification

```bash
cd nextjs-version
pnpm test && pnpm typecheck && pnpm lint
rg "MCA_APPLICATION_INVITATION_EMAIL_ENABLED=true|MCA_SMS_ISV_APPROVED=true|MCA_STRIPE_BILLING_ENABLED=true|MCA_CALENDAR_GOOGLE_ENABLED=true" . ../render.yaml
# from repo root
graphify update .
```

## Dependencies

- Team C will resume `sending` inside `outbox.ts`. Do not touch that branch.
- Team B completeness uses `isDocumentReady`; new uploads will be `clean`.
- Ops must deploy the worker; code cannot make Render Live.
