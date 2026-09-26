# Background job runtime and cutover map (#35)

This is the source inventory and selected non-Render arrangement as of 2026-09-25. **Current production status for every row below: unverified from source; needs live inventory.** The 2026-09-14 [Render audit](render-deployment.md) recorded failed worker builds, an empty queue, only Stripe Supabase functions, and the Stripe sync cron at that time. It is historical evidence, not a current live inventory. No hosted service was contacted for this change.

## Selected arrangement

Vercel Node owns a gated, bounded `/api/cron/jobs` consumer for private CSV export jobs and opt-in auto-submit scoring. It uses the existing PostgreSQL queue: atomic `FOR UPDATE SKIP LOCKED` claim, ten-minute renewable lease, three attempts, token-fenced completion, and 30-second per-attempt backoff. The route limits each request to three jobs and 240 seconds under its 300-second maximum. `MCA_JOB_RUNTIME=vercel_cron` enables the consumer; unset is an authenticated-free no-op and preserves current behavior. `MCA_AUTO_SUBMIT_ENABLED=true` additionally permits `auto_submit` claims; unset or any other value leaves those jobs queued. `CRON_SECRET` authenticates enabled requests by constant-time bearer comparison. The route has no entry in `vercel.json`: an operator must install exactly one schedule after staging acceptance. The existing `MCA_BACKGROUND_JOBS` setting still controls enqueue versus inline processing; it does not activate this consumer. The export dispatcher cases currently have no in-repository production enqueue call; this route proves the runtime contract with an explicitly enqueued synthetic export, and #37 must connect reviewed export producers before claiming production coverage.

The active data plane remains Supabase Postgres, Auth, and private Storage. Vercel uses restricted pooled `DATABASE_URL`, `MCA_DB_POOL_MAX=2`, and no migration-owner credentials. The queue's unique `(workspace_id,kind,idempotency_key)` and lease token keep job identity stable across a killed execution. A stale worker cannot finish or fail the reclaimed row. Export service operations are idempotent by correlation ID or ready state; CSV results are private and authorized on retrieval. This is at-least-once execution; provider sends require their own receipt deduplication and must not be inferred safe from a database lease alone.

Auto-submit scoring can enqueue a separate `submission_delivery` job; this cron route does not claim that delivery. The original outbound approval is carried into the submission queue, and the legacy worker continues to dispatch `auto_submit` through the same queue. Native scanning/PDF, outbound delivery, and unproven large import/intake tasks are **not** selected by the Vercel claim filter. The existing documents Edge handler still returns 503 before claiming. The native path needs a non-Render container or a measured, resumable equivalent with ClamAV signature updates, Poppler, up to 25 MiB private files, scratch space, scanner verification, heartbeat, and a killed-execution retry proof on nonproduction Supabase. Do not enable an Edge documents schedule or promote unscanned files. `scripts/supabase/deploy.mjs` still gates production Edge deployment.

## Queue inventory

All rows below have production status **unverified from source; needs live inventory**. The generic queue rows use `mca_background_jobs`: 10-minute lease, renewal every 30 seconds, at most three claims, 30 seconds times attempt backoff (unless a permanent error), and a stable job ID. `worker.ts` is the dispatcher. “Document host” means the retained Node dispatcher awaiting a non-Render native host; it does not imply Render is operating. The source's 25 MiB upload ceiling applies where noted. External effects need separate deduplication acceptance before scheduler activation.

| Kind | Enqueue path and side effect | Selected runtime / resource boundary |
| --- | --- | --- |
| `export_create` | No enqueue call found; dispatcher snapshots and creates private CSV export | Gated Vercel cron; database/CSV, bounded per invocation; producer is #37 |
| `export` | No enqueue call found; dispatcher finalizes private CSV | Gated Vercel cron; database/CSV, bounded per invocation; producer is #37 |
| `auto_submit` | Deal creation/edit or ready completeness result when the feature and workspace mode are enabled; score and optionally queue an API submission | Gated Vercel cron when both runtime and feature flags are on; shares the export batch, lease, retry, and deadline; delivery remains separately owned |
| `document_upload` | `documents/direct-uploads.ts`; validate private staged upload and promote | Document host; up to 25 MiB, private Storage, scan |
| `document_scan` | `documents/scan-job.ts`; scan deal document before clean state | Document host; up to 25 MiB, ClamAV, scratch file |
| `draft_scan` | No enqueue call found; dispatcher scans private draft PDF | Document host; up to 25 MiB, native scanner |
| `draft_extract` | No enqueue call found; dispatcher extracts approved PDF fields | Document host; PDF/AI runtime, private file |
| `assistant_scan` | `jobs/remote-scan.ts`; quarantine scan generated file | Document host; up to 25 MiB, native scanner |
| `intake_process` | `intake/processing.ts`; parse attachment and create intake records | Document host; private attachment/PDF and provider I/O |
| `email_intake` | `intake/email.ts`; process inbound email application | Document host pending bounded I/O proof |
| `intake_replay` | No enqueue call found; dispatcher replays reviewed intake | Document host pending replay safety proof |
| `multipart_task` | `/api/mca/jobs/multipart`; user requested multipart action | Document host pending per-endpoint file/runtime classification |
| `drive_preview` | No enqueue call found; dispatcher previews package | Document host; private Drive files, potentially large |
| `drive_apply` | No enqueue call found; dispatcher copies package documents | Document host; private Drive files, potentially large |
| `import_commit` | No enqueue call found; dispatcher commits spreadsheet rows | Document host; XLSX parsing and database batch |
| `import_update_commit` | No enqueue call found; dispatcher commits CSV rows | Document host; CSV parsing and database batch |
| `submission_delivery` | `submissions/delivery-job.ts`; lender email/API delivery | Separate outbound worker issue; idempotent provider receipt required |
| `application_invitation_email` | `applications/service.ts`; send invitation email | Separate invitation delivery issue; provider receipt required |
| `application_invitation_reminder` | `applications/reminders.ts`; send scheduled reminder | Separate invitation delivery issue; provider receipt required |
| `billing_reconcile` | Stripe webhook queues by event ID in `billing.ts`; Stripe read/reconcile | Existing `/api/cron/billing` consumer, separate lease/backoff; never claimed by generic worker |

The `billing_reconcile` row uses a ten-minute claim lease and exponential failure backoff in `billing-operations.ts`; `runImmediateBillingReconcile` also runs after webhook response. Billing maintenance sends queued notices with five-minute leases and exponential retry. Neither path needs Stripe write APIs for this proof.

File/runtime bounds: deal and draft uploads and assistant scans are capped at 25 MiB in source; inbound email is capped at 35 MiB raw payload and 25 MiB decoded attachments. The multipart upload table caps each staged object at 25 MiB. Submission packages, Drive packages, imports and CSV export snapshots have no verified per-job worst-case runtime in source, so do not schedule them on a short function solely because the lease is ten minutes. Invitation and billing work have no file input but depend on provider deadlines; their maximum elapsed time is also unverified. A lease is a recovery deadline, not a process time limit. The Vercel export subset has a 240-second request budget: work stops at 230 seconds and lease cleanup has up to 10 more seconds. Export row processing checks the deadline, and scoped PostgreSQL statements use the remaining time as a server-side statement timeout. An expired export attempt is retried by the queue. Maximum-size staged export acceptance is still required before activation.

## Other schedulers and queues

These are separate from `mca_background_jobs`; production status for each remains **unverified from source; needs live inventory**. Runtime and exact operational timing require hosted verification before activation.

| Owner/source | Work, lease/retry, and selected ownership |
| --- | --- |
| `scripts/workers/run.ts` | Historical 1-second document loop: attachment retries, intake scheduling, invitation reminder scheduling, submission recovery, queue dispatch, cleanup, heartbeat. Move each scheduler with its job consumer; do not run two owners. Native stages need document host. |
| `scripts/messaging/worker.ts`, `email-conversations/worker.ts` | OAuth send/reconcile/sync; per-sender 120-second renewed lease, retry in message state. Bounded Supabase `mca-messaging` Edge handler exists behind worker controls, but hosted migration acceptance is pending. |
| `scripts/calendar/worker.ts`, `calendar/sync.ts` | Google calendar sync every five seconds in historical loop; DB sync leases/retry. Select bounded scheduled Vercel Node after provider acceptance; no active schedule is declared. |
| `scripts/assistant/worker.ts` | Release expired credits, experience maintenance, alerts every 30 seconds in historical loop. Select bounded scheduled Vercel Node after acceptance; Edge storage cleanup is not a substitute. |
| `scripts/railway/sms-jobs.mjs`, SMS maintenance API | Five-minute external scheduler comment; token-authorized SMS provisioning/maintenance, provider outcome can be unknown and requires inspection before retry. Select separately authenticated Vercel schedule after SMS acceptance. |
| `/api/cron/comms` | Signed webhook outbox and daily report/digest/follow-up work; `CRON_SECRET`, per-delivery claims and retry policy. Keep existing Vercel Node endpoint; check live schedule ownership. |
| `/api/cron/billing` | Stripe reconciliation, trial notices, billing notification delivery. Historical docs record Supabase pg_cron + pg_net every ten minutes; keep separate from generic cron, verify live state. |
| `scripts/supabase/entries/mca-documents.ts`, `mca-messaging.ts`, `mca-maintenance.ts` | Document handler fail-closed; messaging handler uses worker controls and a 90-second deadline; maintenance cleans private staged objects. Source is not proof of deployed functions/schedules. |
| `supabase/functions/platform-monitor` | Monitoring function source; inspect hosted deployment/schedule before treating it as active. `supabase/functions/README.md` documents local functions. |
| `vercel.json` | Empty; no repository-declared Vercel cron entries. This PR adds none. |

## Proof and acceptance boundary

`tests/jobs-worker.test.ts` uses disposable local PostgreSQL with `MCA_DB_POOL_MAX=2` and synthetic in-memory private storage. It claims a job concurrently, simulates a killed process by expiring its lease, reclaims the **same job ID** with a different token, rejects a stale failure, verifies duplicate-key rejection, delayed retry and the three-attempt terminal state. It also uploads an exact 26,214,400-byte synthetic private PDF, kills the first scan claim, retries it with a mocked scanner, verifies one scan/clean state and the same job ID, and records duration and bytes in test diagnostics. No external message or funder submission is sent. The HTTP tests prove the runtime flag defaults off, missing secret fails closed, wrong bearer is rejected, an authenticated tick completes a synthetic private export, and an auto-submit score-only job remains queued until both runtime and feature flags are on. The legacy worker also completes an auto-submit job. This local proof does **not** prove native binaries or private Supabase Storage behavior on a hosted runtime. Worker credentials are source-checked and locally exercised through `CRON_SECRET` constant-time comparison; staging must verify the restricted role, pooler saturation, and concurrent cron ticks under load.

## Deployment, monitoring, rollback

### Environment contracts

| Runtime | Exact required configuration before enabling |
| --- | --- |
| Export and auto-submit cron on Vercel | `MCA_JOB_RUNTIME=vercel_cron`, existing `CRON_SECRET`, restricted pooled `DATABASE_URL`, `MCA_DB_POOL_MAX=2`, `MCA_DOCUMENT_STORAGE_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `MCA_APP_ORIGIN`, and the existing Supabase browser keys for the web app. `MCA_BACKGROUND_JOBS=enabled` remains the enqueue switch where used; `MCA_AUTO_SUBMIT_ENABLED=true` additionally permits auto-submit enqueue and claim. No migration-owner URL/key in runtime. |
| Native document host, future #36 | Restricted pooled `DATABASE_URL`, `MCA_DB_POOL_MAX` sized for one worker, `MCA_DATA_ENCRYPTION_KEY`, `MCA_APP_ORIGIN`, `MCA_DOCUMENT_STORAGE_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, private document/quarantine/artifact bucket names if overridden, `MCA_DOCUMENT_SCANNER=clamscan` or `clamdscan`, matching native scanner executable/signature database and Poppler. Provider keys only for features being accepted. Keep absent until hosted proof. |
| Messaging Edge, future #38 | `MCA_EDGE_WORKER_TOKEN` (at least 32 bytes), restricted database credentials, `MCA_DATA_ENCRYPTION_KEY`, `MCA_APP_ORIGIN`, sender OAuth credentials, and worker-control activation. Set one schedule only after hosted sender lease/reconnect proof. |
| Billing/comms existing routes | Existing `CRON_SECRET` and their current provider configuration; do not change schedule ownership in this issue. |

Secrets belong in the target secret store. Do not copy production values into agent or disposable environments.

1. Merge code with `MCA_JOB_RUNTIME` unset; verify no new consumer runs. Keep `MCA_BACKGROUND_JOBS` at its existing value. Do not use production credentials in test environments.
2. On approved synthetic staging, verify the restricted `DATABASE_URL` and Supabase private Storage credentials, `CRON_SECRET`, `MCA_DB_POOL_MAX=2`, exact export permissions, concurrent claim/fence behavior, maximum export runtime, and `mca_background_jobs` queue depth/oldest age. Install one schedule for `GET /api/cron/jobs` only after these pass. Set `MCA_JOB_RUNTIME=vercel_cron` on that target.
3. Inspect response `processed`/`durationMs`, `worker_job_completed`/`worker_job_failed` logs, queued/running/failed counts, expired leases, attempt counts and pooler connections. A 200 cron response with `processed:0` proves only that the tick ran. Keep billing/comms schedules independently owned.
4. For document, messaging, calendar, assistant, SMS, submission and invitation follow-up issues, perform their own nonproduction provider/native and killed-execution acceptance, assign exactly one scheduler, then cut over individually. Verify current live inventories before declaring production status.
5. Roll back cron consumption by unsetting `MCA_JOB_RUNTIME` or removing its schedule. Unset `MCA_AUTO_SUBMIT_ENABLED` to stop new auto-submit claims while retaining export consumption. Existing queue identities and data remain; do not delete old services, objects or rows. Keep document Edge handler fail-closed. Before any outbound rollback/replay, inspect provider receipts; database leases cannot prove a send did not happen.

The auto-submit tables are added by the existing additive `0059_auto_submit.sql` migration; this consumer change adds no migration. No Vercel setting, Supabase function, pg_cron schedule or hosted data was changed by this issue.
