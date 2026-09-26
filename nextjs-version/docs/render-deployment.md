# Render dependencies after the Supabase cutover

Historical audit only. Render is not an active target in the current architecture. Its service states and recovery instructions below describe the September 2026 audit, not a current production deployment plan. Use [the background job cutover map](background-job-runtime.md) for current ownership and activation gates.

Audited 2026-09-14 using Render's live service/deploy/log inventory and read-only Supabase queries. Workspace: Michael's workspace (`tea-da86hgegekts73ccou40`). Blueprint: `exs-dahc2u9t0dsc73ff9l70`. The public `https://fundlane.io` returned HTTP 200 with `server: Vercel`. Supabase project `drubsfvhlggmtyiigwxy` is healthy.

## Live inventory

| Render resource | Observed state | Decision |
| --- | --- | --- |
| [fundlane](https://dashboard.render.com/web/srv-dahc3veq1p3s73eatung), `srv-dahc3veq1p3s73eatung` | User-suspended since September 13; auto-deploy changed from `checksPass` to off by this audit | Removed from active `render.yaml`. Keep suspended for rollback until disk/callback audit is complete. |
| [fundlane-chatkit](https://dashboard.render.com/pserv/srv-dai0u267bikc73e3ed5g), `srv-dai0u267bikc73e3ed5g` | User-suspended since September 13; private Python service, port 8000; auto-deploy changed from `checksPass` to off by this audit | Removed from active Blueprint; retain source and suspended service for rollback. |
| [fundlane-document-worker](https://dashboard.render.com/worker/srv-dajm1i7qj5pc73e5n7j0), `srv-dajm1i7qj5pc73e5n7j0` | Not suspended, auto-deploy off, **only deployment failed to build** (`dep-dajm1ifqj5pc73e5n9eg`, revision `2e1d2fcc7bd49d2c4d0845d74cabb3059a07d0f7`) | Preserve. Required native/general job executor; not currently verified running. |
| [fundlane-messaging-worker](https://dashboard.render.com/worker/srv-dajme5nqj5pc73e79ee0), `srv-dajme5nqj5pc73e79ee0` | Not suspended, auto-deploy off, **only deployment failed to build** (`dep-dajme5vqj5pc73e79fgg`, revision `313427220d8d1668978f538043e3a1b27f968eed`) | Preserve until a hosted Supabase replacement passes acceptance. |
| `fundlane-documents`, `dsk-dahc3veq1p3s73eatvc0` | 10 GB disk attached to suspended web service, mounted at `/data` | Retain pending object-transfer/backup verification. Disk contents were not inspected; do not delete on the assumption that Storage migration copied everything. |

No Render Postgres, Key Value, additional services, cron services, or previews were returned. Neither worker has a successful deployment; there were no recent runtime logs. Both builds failed at `pnpm install --frozen-lockfile` with `ERR_PNPM_IGNORED_BUILDS` (esbuild/sharp/unrs-resolver). Their Dockerfiles omitted `pnpm-workspace.yaml`, which contains the existing build-script approval policy. The local fix copies that file before installation in document, messaging, calendar, and fallback web Dockerfiles; it does not relax the policy.

Supabase currently lists only `stripe-setup`, `stripe-webhook`, and `stripe-worker`. Its sole cron job is active `stripe-sync-worker` (`*/1 * * * *`). `mca_private.worker_controls` does not exist there. `mca_background_jobs` was empty at audit time; this does not establish future processing readiness. No MCA Edge worker replacement is active. Leave Stripe functions and schedules untouched.

The Edge migration files referenced below were observed in the existing local in-progress workspace; they are not shipped by this documentation/build-fix PR and are not proof of a production deployment.

## Dependency trace and migration boundaries

| Capability / source | Dependency and action |
| --- | --- |
| Website, authentication, database, private documents | Vercel plus Supabase. Remove obsolete web/domain/disk provisioning and private-service wiring from active Blueprint. Do not regenerate `MCA_DATA_ENCRYPTION_KEY` or storage/token secrets. |
| `scripts/workers/run.ts` → `jobs/worker.ts` | Document worker handles intake scheduling and attachment retries, upload/scan/draft extraction, assistant file scanning, multipart tasks, Drive import, import commits, exports, submission delivery and application invitation emails. It also invokes `jobs/cleanup.ts`. Retain the full dispatcher, not just antivirus. |
| `Dockerfile.worker`, `documents/scanner.ts` | Node subprocess scanner (`clamscan`) and installed Poppler tools. Supabase Edge does not replace this container/native execution model. Remote Cloudmersive/Verisys experiments do not complete the dispatcher migration. |
| `scripts/messaging/worker.ts` → `email-conversations/worker.ts` | OAuth mailbox send/reconciliation/sync with durable sender leases. Requires Supabase DB, existing encryption key, origin and Google/Microsoft credentials. No scanner or Supabase secret key needed. Candidate for bounded Edge migration, but not deployed or accepted. |
| `scripts/supabase/entries/mca-documents.ts` → `jobs/edge-handler.ts` | Explicitly returns 503 `document_migration_incomplete` before claiming work. Do not enable it or retire the document worker. Processing is not live until a Live worker deploy shows a fresh heartbeat. |
| `scripts/supabase/entries/mca-messaging.ts`, `mca-maintenance.ts` | Bounded messaging and storage cleanup implementations; no production functions, controls or schedules. Production deployment is explicitly gated in `scripts/supabase/deploy.mjs`. |
| `assistant/gateway.ts`, `native-runtime.ts`, `chatkit-service/` | Legacy Python path uses `MCA_ASSISTANT_SERVICE_URL` and signed permission callbacks. Native path requires `MCA_ASSISTANT_RUNTIME=supabase` and an HTTPS function URL. No production `mca-assistant` exists; source availability is not activation. Keep Python suspended and retain rollback code. A Render private hostname is not reachable from Vercel. |
| `scripts/assistant/supervisor.cjs`, `scripts/assistant/worker.ts` | Old web container started assistant account maintenance only when enabled. Suspended web cannot perform it. Edge storage cleanup is not equivalent to reservation release, experience maintenance and credit alerts; these require separate acceptance before enabling assistant features. |
| `scripts/calendar/worker.ts`, `Dockerfile.calendar` | Separate Google Calendar sync entrypoint; absent from live Render inventory and active Blueprint. Do not claim scheduled calendar sync is running. |
| `scripts/railway/sms-jobs.mjs`, intake/comms job HTTP routes | Legacy/manual schedulers, not live Render cron services. Preserve existing token/admin authorization; no new schedules activated. |
| `.env.example` `MCA_INGRESS_ORIGIN` | Unused by application code. Removed misleading claim that a Render HTTPS ingress exists. Provider callbacks and any configured `MCA_DEMO_WEBHOOK_URL` still need a secret-store/provider-console URL audit. |
| `scripts/marketing/inbox.ts`, `docs/marketing-site.md` | Use trusted Supabase-configured operator CLI; do not rely on suspended Render shell. Legacy privacy copy in `docs/marketing-privacy-draft.md` and `src/lib/marketing/privacy-notice.ts` still needs review before publication. |
| `Dockerfile`, `railway.json`, `scripts/railway/`, historical acceptance docs | Retained fallback/history, not active Render web deployment. `ARCHITECTURE.md` and ChatKit guide now explicitly mark historical deployment instructions. |

Supabase Edge functions have 256 MB memory and 2 seconds CPU per request; background tasks remain subject to runtime limits. Native/large-file work needs a measured resumable implementation, not a scheduler switch. See [Supabase limits](https://supabase.com/docs/guides/functions/limits) and [background tasks](https://supabase.com/docs/guides/functions/background-tasks).

## Exact Render steps to stop infrastructure notifications

These settings control Render infrastructure messages, not Fundlane email delivery, invitation emails, or processing. Notification preferences were not changed by this audit.

1. Select **Michael's workspace**. Open **Integrations → Notifications**.
2. Set **Default Service Notifications → None** and save. Check **Notification Overrides**: each of the four services above must use the workspace default or explicitly select **None**. Alternatively, to mute MCA only, open each linked service → **Settings → Notifications**, set its notification level to **None**, and save. This covers email/Slack service alerts. See [Render notification settings](https://render.com/docs/notifications).
3. If Blueprint sync-failure messages continue, use the workspace default above. Open Blueprint `exs-dahc2u9t0dsc73ff9l70` → **Settings → Auto Sync → No** to stop automatic infrastructure syncs while reviewing this cleanup. Service auto-deploy off is separate from Blueprint auto-sync.
4. On the two suspended legacy services, leave them suspended and set **Settings → Build & Deploy → Auto-Deploy → Off**. Keep both worker services present with auto-deploy off. Disabling auto-deploy does not stop an already running worker; it also does not repair these failed builds.
5. If notifications originate from a separately configured Render webhook/automation, inspect that integration separately; service email/Slack preferences do not reconfigure external webhook receivers. No external webhook inventory was obtained in this audit.

Do not suspend/delete workers, remove provider credentials, disable Stripe cron, or rotate encryption keys to silence notifications. Muting also hides infrastructure failure alerts; use dashboard/log checks while recovering the workers.

## Apply cleanup and recover processing

1. Review and release the two-worker `render.yaml` and Dockerfile changes from a coherent application revision. This working tree contains substantial other in-progress changes; the audit did not publish them or trigger a production deploy.
2. Validate from the repository root: `render blueprints validate render.yaml --workspace tea-da86hgegekts73ccou40 --output json`. Sync the reviewed Blueprint manually. Render does not delete resources omitted from YAML; keep the legacy services suspended. [Blueprint deletion and sync semantics](https://render.com/docs/infrastructure-as-code).
3. For each worker, verify its **Environment** matches the current Supabase project, using restricted pooled `DATABASE_URL`, the unchanged encryption key, and `MCA_APP_ORIGIN=https://fundlane.io`. Document worker also needs Supabase URL/secret, private storage buckets (if overriding defaults), OpenAI/provider configuration and scanner readiness. Messaging needs the registered OAuth client credentials. Add `sync: false` secrets manually on existing services; Blueprint updates do not populate them. Do not copy historical Neon/Clerk connections.
4. Verify additive migrations/runtime grants for intake, invitations, calendar and messaging before activation. Build both worker images and deploy the reviewed revision using **Manual Deploy → Deploy a specific commit**. Confirm each reaches **Live**; inspect document scanner signature initialization and runtime job logs, and messaging tick logs. Builds alone do not establish provider readiness.
5. Exercise controlled upload → quarantine → scan → promotion → extraction/review, retry/lease recovery and authorized submission scenarios; test mailbox send/reply/reconciliation with an approved pilot sender. Keep real side-effect processing gated until provider configuration is verified. Current Linear [MIC-96](https://linear.app/michael-belenkiy/issue/MIC-96/authenticated-parity-audit-and-end-to-end-release-acceptance) remains Backlog and is blocked by MIC-99/MIC-92/MIC-100/MIC-102.
6. Later messaging migration: install reviewed controls/grants, deploy a bounded staging function, verify provider deadlines/leases/duplicates/revoked access, drain the Render worker, enable exactly one production scheduler, and observe accepted/synced messages before retiring it. Empty queues and mock tests are insufficient. Document migration additionally needs all dispatcher kinds and maximum-size native/scanner replacement acceptance.
7. Delete the old web service/disk only after private Storage parity, backups and rollback retention are verified and provider/Vercel callback URLs no longer depend on `fundlane.onrender.com`. ChatKit deletion likewise requires confirmation it is not a rollback requirement. No service/disk was deleted during this audit.

### Worker recovery gates

Document and submission processing is not live until a Live Render document-worker deploy shows a fresh heartbeat (`mca_private.ops_control.document_worker_heartbeat_at`, surfaced on `/admin/status` and health `workerReady`). Vercel may enqueue `document_scan` / `submission_delivery`; Render `scripts/workers/run.ts` is the consumer. Keep the Edge documents handler fail-closed (503 `document_migration_incomplete`); do not enable it or retire the Render document worker to “recover” processing.

## Verification and limits

Render Blueprint validation passed (`valid: true`). Both Node worker bundles compile locally after the configuration fix. A clean pnpm 11.1.2 frozen install with the three copied configuration files passed without `ERR_PNPM_IGNORED_BUILDS`; macOS emitted an optional Sharp native-build warning. Full Linux Docker image verification was not completed because the local Docker daemon did not respond. Live inventory, deployment failures, Supabase functions/cron/empty queue, and public Vercel response were checked read-only. Secret values, legacy disk contents, provider-console callback URLs and hosted end-to-end processing were not verified. Automatic deploys were disabled live on the two suspended legacy services and their suspended state was preserved. Other deployment configuration changes remain local until released.

## Clerk verification (2026-09-14)

Current main uses Supabase Auth in `src/proxy.ts` and `src/lib/mca/auth.ts`; its package manifest has no Clerk SDK. Legacy database identifier columns remain for migrated records. The Clerk account still contains MCA application `app_3J6N3t7eRGSb3u1BO7wUTIEsxyx`, with development and production instances. A read-only production audit checked both users and found **two active Clerk sessions**. This does not prove Fundlane still calls Clerk, but it prevents claiming Clerk has been fully retired. No Clerk users, sessions, application or webhook configuration were deleted. Other Clerk applications are outside MCA scope.
