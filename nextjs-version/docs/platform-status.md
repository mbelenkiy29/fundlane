# Platform status

When both `MCA_CALENDAR_GOOGLE_ENABLED=true` and `MCA_CALENDAR_RUNTIME=vercel_cron`, the owner status API and dashboard include aggregate Google Calendar connection health: stale syncs over ten minutes, connections with failures, reconnect-needed connections, and selected push watches missing or expiring within 24 hours. These are current database counts; the response excludes credentials, event content and user identifiers. See [calendar deployment and recovery](pipeline-calendar.md).

`/admin/status` is a separate owner console. Its API validates the live Supabase session and compares the immutable user ID to `MCA_PLATFORM_OWNER_USER_ID`. Company roles cannot grant access. The ordinary app header shows a link only for the configured owner; the link is not an authorization mechanism.

## Metrics

Health is sampled every minute, not inferred from successful business requests. Availability is successes divided by observed samples. Missing samples are not claimed as uptime. Health is stale after three minutes. Query failures remain unavailable, never zero. Current queue/email cards are all-time/current-state snapshots; charts and usage use the selected UTC window. Submission counts cover tracked application invitations, not unrelated intake. Email acceptance does not prove delivery or inbox placement.

Document failure and scanner counts are zero while both document runtime flags are unset, and their owner dashboard alerts are hidden. When activating document consumption, set the selected existing flag (`MCA_DOCUMENT_JOB_RUNTIME=vercel_cron` or `MCA_NATIVE_DOCUMENT_EXECUTOR=true`) in both the web host and the Supabase `platform-monitor` function secrets. Values other than those exact strings remain disabled. Keep both unset to preserve the current production owner page. The heartbeat warning remains independently visible.

Activity records one row per local user per UTC day and updates the last activity time on authenticated foreground API requests. GET endpoints also used for polling (session, jobs, mail, SMS, assistant, application lists, intake, calendar, senders), sync/status endpoints and automatic read receipts are excluded. Foreground mutations still count. Passive views of these polled screens are deliberately not claimed as engagement. This is API activity, not page views or complete analytics; read-only mailbox polling cannot establish active use. Collection is not backfilled. Existing invitation records supply real historical invitation counts.

Only allowlisted telemetry metadata is stored. Never pass exception messages, request bodies, SQL or provider payloads into event records. App errors always reach native logs; persistence runs with a separate single-connection pool and subsecond timeouts. Disable `MCA_OPERATIONS_ENABLED` to stop persistence without changing request behavior.

## Release order

1. Confirm the existing owner's login email and alert/test recipient. Resolve `users.supabase_user_id` using a parameterized query for that exact email, verify the Auth identity is active, and configure the immutable ID. Never infer ownership from a company role or auto-promote an account.
2. Apply only migration 0037 using the guarded script, with a migration-role connection identifying the Fundlane project:
   `node --import tsx scripts/operations/apply-schema.mjs --expected-project-ref=drubsfvhlggmtyiigwxy`.
   It requires `NEXT_PUBLIC_SUPABASE_URL`, `DATABASE_URL_UNPOOLED`, and existing Drizzle history through 0036. It records the correct migration hash so ordinary subsequent migrations do not run it again.
3. Set Vercel server-only `MCA_PLATFORM_OWNER_USER_ID`, `MCA_OPERATIONS_ENABLED=true` and a randomly generated 32-byte-or-longer `MCA_MONITOR_TOKEN`. Deploy the reviewed website revision. Confirm the owner page and 401/403 protections before activating monitoring.
4. Store the same monitor token as a Supabase secret and as Vault secret `fundlane_monitor_token`. Add `MCA_MONITOR_DATABASE_URL` using restricted `mca_app` through the transaction pooler on port 6543, `MCA_APP_ORIGIN=https://fundlane.io`, and `MCA_OPERATIONS_ALERTS_ENABLED=false`. Do not copy the migration/admin connection into the function.
5. Run `node scripts/operations/deploy-monitor.mjs --expected-project-ref=drubsfvhlggmtyiigwxy`. This deploys only `platform-monitor`; it does not prune Stripe functions or change schedules.
6. Invoke manually with the dedicated secret. Verify a real website/database sample and queue aggregates in `mca_private.ops_health`. Verify a public project key is rejected.
7. Apply `scripts/operations/schedule.sql` to the verified project. It upserts only the named monitoring schedule and requires the Vault credential. Check the next two cron invocations.
8. Ensure the existing transactional webhook receiver supports the new `operations_alert` template and honors its idempotency key. Configure its URL/token and the confirmed recipient as Supabase secrets. Use an isolated test database with the real receiver and explicitly designated test recipient for one opening/recovery episode before setting `MCA_OPERATIONS_ALERTS_ENABLED=true`.

Alert emails contain only component, timestamp, a safe opening/reminder/recovery summary, and the owner dashboard URL. The shared webhook transport is used by both application email and the monitor. No fallback provider is added. Provider timeouts remain unknown and do not automatically retry. Review ambiguous alert delivery in native provider logs before reconciling its record; business-message retry rules are unaffected.

Health/database failures need three consecutive checks. Queue age over ten minutes and expired leases also need three checks. A retrying `billing_reconcile` job opens a dedicated `billing_reconciliation` incident on one check; the durable job remains queued with backoff until reconciliation succeeds. Five errors in five minutes, any ambiguous outbound send, or five email failures in ten minutes open an incident immediately. One alert is sent per tick; six-hour reminders and three-healthy-check recoveries suppress repeated notifications.

## Failure and rollback

A full Supabase outage can stop custom checks and alerts. Email outages can prevent notifications. Consult Vercel/Supabase directly when samples are stale or the app cannot authenticate. Unknown/rejected notification outcomes are visible separately from business email state.

Disable only `fundlane-platform-monitor` with `cron.unschedule`, then set alerts and collection flags false and remove the platform owner setting if rolling back access. Retain all business records and additive operational tables. Native host logs remain available. No DNS or worker migration is part of this release.

## Verification

Run database-backed tests with an isolated `MCA_TEST_DATABASE_ADMIN_URL`:
`node --experimental-test-module-mocks --conditions=react-server --import tsx --test tests/platform-status.test.ts tests/platform-status-http.test.mjs tests/supabase-auth.test.ts tests/foundation-core.test.ts tests/email-conversations.test.ts tests/submissions-email.test.ts`.

Run `node scripts/operations/build-monitor.mjs` and `deno check --node-modules-dir=none --unstable-sloppy-imports scripts/operations/edge-entry.ts`, then normal typecheck/lint/build. CI rebuilds the committed Edge bundle and rejects drift. The browser design preview route is temporary and must never be committed.
