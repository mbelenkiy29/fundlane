# Pipeline calendar and Google Calendar

The `/calendar` page uses real deal activity. The pipeline deal dialog has a Schedule tab using the same editor and API. Desktop opens in month view; small screens open in agenda view. Month, week, day, and agenda views support calls, manual follow-ups, planned submissions, automated follow-up occurrences, sent-submission history, and personal Google overlays.

## Behavior and authorization

Calls default to 30 minutes. Manual activities belong to one deal and one active workspace member; the assignee must be able to access that deal. All-day tasks store date-only values with an exclusive end date. Timed activities store UTC instants and their IANA timezone. Nonexistent local times during daylight-saving transitions are rejected. Ambiguous fall-back times resolve deterministically through the shared wall-clock converter.

My calendar selects manual activity by assignee and system activity by deal assignments. Team mode requires manager/admin access and applies existing deal visibility; it does not expose another user's Google events. Updates require both deal access and assignment-management permission. API handlers require an interactive session and the Deals page permission. Every activity change and conflict decision has an audit record; internal notes use the existing workspace encryption key.

Automated follow-ups are read-only projections of enabled policies against currently eligible deal stages. Stored outcomes take precedence over projected occurrences. Calendar reads never enqueue messages. Planned submissions are personal tasks, not scheduled package delivery; completion and submission remain separate actions.

Migration `0034_pipeline_calendar.sql` adds six tables plus `mca_submission_attempts.sent_at`, captured when an attempt first becomes sent. This prevents a queued attempt's creation date from appearing as its delivery date. Historical attempts without a delivery timestamp use the job's last recorded update; their details explicitly disclose this approximation. Multiple sent attempts for one submission job produce one calendar entry.

## Google integration

Each user can connect one Google account per workspace. Calendar authorization uses its own OAuth client configuration, PKCE, expiring one-time state bound to the signed-in user, membership and workspace, and encrypted offline credentials. It does not reuse Gmail send permissions or change the application's login provider.

Scopes:

- `openid` and `email` identify the Google account.
- `calendar.calendarlist.readonly` lists selectable calendars.
- `calendar.events.readonly` reads Google events.
- `calendar.app.created` creates and edits the dedicated Fundlane calendar.

References: [Google authorization scopes](https://developers.google.com/workspace/calendar/api/auth), [incremental synchronization](https://developers.google.com/workspace/calendar/api/guides/sync), [push notifications](https://developers.google.com/workspace/calendar/api/guides/push).

The dedicated Fundlane calendar exports assigned calls, manual follow-ups and planned submissions. Title, start/end and cancellation synchronize in both directions. Deal linkage, assignee, notes and completion remain controlled by Fundlane. No attendees are added and no invitations or business messages are sent. Google entries include an authenticated link to their deal and a ten-minute popup reminder for scheduled activities; completed activities become transparent and lose reminders.

Selected external calendars are read-only overlays; primary is selected initially, with up to 20 calendars selectable. Google-created events without a mapped pipeline activity are overlays, including those created directly in the dedicated calendar. Recurring events are expanded into occurrences. The rolling cache covers the past 93 days and next 366 days and is rebuilt daily; pipeline history can be browsed beyond that window. The UI states the Google coverage limit. A `410` sync-token response rebuilds only the affected calendar cache. Pagination must complete before its next sync token is committed.

Pipeline activity is single-occurrence in v1. Adding recurrence to a mapped Google event surfaces a conflict: Keep Fundlane replaces it with a single occurrence, or the user can fix it in Google. Google changes cannot turn a completed task back into a pending task. Cancellation preserves the local activity record; restoration creates a new, deterministic Google event generation.

Event IDs derive from connection, activity and restoration generation. Baselines, local versions and Google ETags distinguish local edits, remote edits and conflicts. If both calendars changed, neither silently overwrites the other. The user's decision includes the local version and remote ETag; another remote change requires a fresh decision. Retry after a successful Google insert and an interrupted database commit recovers the same event. A dedicated-calendar description marker likewise recovers an interrupted calendar creation.

## Worker and deployment

Calendar connections are durable reconciliation jobs: `next_sync_at`, status, failures and last sync survive process restarts. New local activity, settings changes, and authenticated Google push messages bring reconciliation forward. A five-minute poll catches missed notifications. PostgreSQL transaction advisory locks serialize each connection across workers, settings changes and disconnects. Network calls have timeouts; transaction rollback and deterministic provider IDs support recovery after crashes. Calendar activity writes and worker reconciliation serialize through connection rows so incoming Google edits cannot overwrite a concurrent local save.

The selected runtime is a dedicated Vercel Node cron endpoint, `GET /api/cron/calendar`. It requires both `MCA_CALENDAR_GOOGLE_ENABLED=true` and `MCA_CALENDAR_RUNTIME=vercel_cron`; unset values preserve the current disabled behavior. `CRON_SECRET` authenticates an exact bearer token. Each request holds one PostgreSQL transaction advisory lock on a separate connection across instances, processes at most three due connections, and stops before a 230-second work deadline within a 300-second function limit. This works with the runtime transaction pooler while connection reconciliation retains its own transaction and conflict lock. A five-minute schedule provides missed-notification polling and watch renewal; concurrent ticks return `busy: true`. Do not schedule the historical worker at the same time.

The standalone worker remains a historical/local verification entry point:

```sh
pnpm calendar:worker
# One pass for deployment verification:
pnpm calendar:worker -- --once
# Build a self-contained Node worker:
node scripts/calendar/build.mjs
node .next/calendar-worker.cjs --once
```

`Dockerfile.calendar` is historical deployment packaging. Render is historical and is not the scheduler for this integration. The web application and cron route run on Vercel with Supabase Postgres, Auth, and private Storage. No hosted schedule is provisioned by this code change.

Required environment on the Vercel app and cron route:

- `DATABASE_URL`: existing restricted runtime connection.
- `MCA_DATA_ENCRYPTION_KEY`: existing workspace encryption key.
- `MCA_APP_ORIGIN`: canonical HTTPS app origin.
- `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`.
- `MCA_CALENDAR_GOOGLE_ENABLED=true` after staging acceptance. Default is disabled.
- `MCA_CALENDAR_RUNTIME=vercel_cron` after staging acceptance. Default is unset/disabled.
- `CRON_SECRET`: existing Vercel cron bearer secret.

In an approved nonproduction Google Cloud project, enable Google Calendar API, create a Web application OAuth client, configure the OAuth consent screen with the scopes above, and add the staging Google accounts as test users. Register `${MCA_APP_ORIGIN}/api/mca/calendar/google/callback` as an exact authorized redirect URI. Configure the public application's consent verification as required for its requested scopes. The webhook `${MCA_APP_ORIGIN}/api/mca/calendar/google/webhook` must accept public HTTPS POSTs; Google Calendar watch registration uses that URL and authenticates channel ID, hashed channel token, resource ID and channel expiry. Expiring watches are renewed a day early. Local HTTP development uses polling.

The existing additive `0034_pipeline_calendar.sql` migration and its restricted-role grants must be present on the target. If absent on an approved nonproduction target, apply it using the existing guarded migration command, then run `db:secure` against that same verified destination. This cron change adds no migration. Browser roles have no direct calendar-table access; the restricted server role receives access through the established grants/RLS setup. Builds do not apply migrations.

Deploy in this order: verify existing calendar migration/grants, deploy the web application with both flags off, complete Google staging verification, install exactly one Vercel cron schedule for `GET /api/cron/calendar` every five minutes (`*/5 * * * *`) with `CRON_SECRET`, then enable both flags. Do not add a second scheduler or reuse the standalone worker. The pipeline calendar works without a Google account. Disconnect stops watches when access allows, deletes credentials, mappings and cached personal events, and retains local activities and existing Google calendar entries. Expired access never prevents local disconnection. Deactivated membership or removed Deals-page access purges the connection on reconciliation.

Monitor cron `processed`, `busy`, and `durationMs`, structured `calendar_sync_failed` logs, and the owner-only `/admin/status` Google Calendar panel. It counts stale connections (last sync older than ten minutes), failed connections, reconnect-needed connections, and selected watches absent or expiring within 24 hours. A `processed: 0` response alone does not prove provider health. No credentials or event bodies appear in status or logs. Network/provider failures retry after five minutes; authorization failures show Reconnect. Alert operationally on nonzero stale/failure/watch counts after verifying the schedule and Google account state. The user UI exposes last sync, retry, reconnect, conflicts and disconnection.

To disable, unset `MCA_CALENDAR_RUNTIME` first and remove the Vercel schedule; unset `MCA_CALENDAR_GOOGLE_ENABLED` to hide Google connect/sync from users if provider access must also stop. Leave local activities and encrypted connection records intact. For recovery, inspect the owner status counts and sanitized runtime logs, verify Google OAuth configuration and webhook reachability, reconnect revoked accounts through the user UI, restore the single schedule, and enable both flags only after a staging tick shows a fresh `last_sync_at`, renewed watch, and resolved or explicitly surfaced conflicts. Do not replay provider writes blindly or clear sync tokens in bulk.

## Interfaces

All endpoints below live under `/api/mca/calendar`:

- `GET /?from=ISO&to=ISO&scope=mine|team&dealId=optional`: authorized events, safe deal options, assignee options, timezone and capabilities; maximum range 93 days.
- `POST /`, `PATCH /activities/:id`: validated full activity input. Updates require the current `version`; stale writes return `409`.
- `GET /google`, `PATCH /google`: personal connection state; actions `select`, `sync`, `disconnect`.
- `POST /google/connect`, `GET /google/callback`: Google OAuth flow.
- `POST /google/webhook`: authenticated provider notification; queues reconciliation only.
- `POST /activities/:id/resolve`: `{ choice: 'local' | 'google', version, etag }` queues an explicit conflict decision.

Google credentials, sync tokens and internal mappings are never returned by these interfaces. Automated items and imported Google events are never writable through activity endpoints.

## Verification

Use an isolated disposable database, never application data:

```sh
MCA_TEST_DATABASE_ADMIN_URL=postgresql://... node --experimental-test-module-mocks --conditions=react-server --import tsx --test tests/calendar.test.ts
pnpm typecheck
pnpm lint
pnpm build
```

The focused suite covers date/DST validation, assignment/workspace/manager isolation, HTTP authorization, one-time OAuth state, sync identity, completion/cancellation/restoration, simultaneous edits, rollback recovery, personal overlays, pagination, token invalidation/refresh, webhook authentication, assignment/access changes, automated projections, and submission delivery timestamps.

For a local UI fixture using the actual component and synthetic API responses, run `node scripts/calendar/preview.mjs`. It binds only to `127.0.0.1:5876`, never connects to a database, and removes its temporary bundle on shutdown. Verify responsive views, scheduling, completion, filtering, error states, and keyboard-accessible dialogs. This fixture is not an OAuth integration test.

Staging acceptance with a real Google account remains a release prerequisite: consent and offline refresh, create/move/cancel in both calendars, all-day and recurring overlays, worker restart, webhook renewal, token revocation/reconnect, conflict resolution, private-team isolation, and disconnect. Local simulated-provider success does not establish production readiness.

### Local verification record — September 13, 2026

- 35 tests passed across the calendar, follow-up, submission core, portal, duplicate, and status suites using a newly created disposable local PostgreSQL 17 cluster.
- Typecheck and the production Next.js build passed. Focused calendar lint was clean; full-project lint had no errors and reported unrelated warnings.
- The standalone calendar worker bundled successfully and started/exited with Google disabled.
- Playwright exercised the real component with synthetic responses at 1440×1000 and 390×844: view switching, call creation, mobile all-day follow-up creation/completion, dialog completion, and no mobile page overflow. Synthetic screenshots are saved under workspace `output/calendar/`.
- Google OAuth credentials were not configured locally; real-account OAuth, delivery, push renewal and production activation remain unverified release prerequisites.

The calendar migration is replay-safe and includes the established server-only RLS grants without changing role credentials. When released independently of earlier pending migrations, it may be applied through Supabase migration history first; do not advance the Drizzle journal past unapplied earlier entries. A later normal guarded migration run can safely replay it and record the ordered Drizzle journal.

### Main release verification

The isolated main-based release passed 16 calendar tests, including repeated migration replay, typecheck, focused lint, and the production build. The six calendar tables were applied to the `fundlane` Supabase project with RLS enabled, `mca_app` access, and no browser-role grants. Google credentials remain unconfigured and the integration remains disabled.
