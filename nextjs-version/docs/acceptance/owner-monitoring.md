# Owner monitoring read-only acceptance

This slice keeps the existing status service, runtime flags, scheduled monitor, incident rules and recovery behavior. It adds no recovery controls, alert recipients, notification delivery, scheduler, provider calls or database migration.

The dashboard treats missing or stale sampled health as **Unavailable**. Response-time cards and sample-derived queue/email counts hide stale values; the last sample timestamp remains visible. Historical observed availability still describes recorded samples only. Fresh database queries for job kinds, email/calendar runtime and incidents remain visible even when the scheduled health sample is stale. A failed refresh clears the prior snapshot, error rows and pagination cursor, and shows the request error; initial loading cannot claim an empty error history. Missing response measurements have no numeric/unit display.

Global errors retain only the existing sanitized metadata fields. The UI explicitly says company attribution is unavailable; route and correlation identifiers are not used to guess a company. Failed jobs remain aggregate counts by kind behind the existing status flag, with pending age and last completion; this view does not display payloads or invoke recovery.

## Evidence and limits

`tests/status-dashboard.test.ts` uses the existing React server-rendering/subprocess pattern. Its refresh test drives the actual component's fetch callback with isolated hook state and fake HTTP responses, then renders the returned UI with real React. It covers stale and missing samples, success followed by refresh failure, initial loading and null measurements. It needs no new dependency. Database-backed platform status tests also check stale successful samples and the exact global error field allowlist; existing HTTP authorization and recovery tests remain applicable.

Authenticated browser acceptance on an approved staging identity remains outstanding; these tests do not exercise browser hydration, visibility, network races or real Supabase sessions. The controller records combined-suite and independent-review evidence before integration.

A full Supabase outage can prevent both collection and alert delivery, since monitoring depends on that database. Missing samples never establish uptime. The existing fallback is direct Vercel runtime logs and Supabase diagnostics (linked in the dashboard); no independent uptime guarantee or new alert channel is introduced. Hosted deployment, scheduler inventory, and provider notification checks remain separate acceptance work.
