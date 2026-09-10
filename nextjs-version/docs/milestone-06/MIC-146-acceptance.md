# MIC-146 acceptance — Opt-in daily deal activity email digest

Executed September 9, 2026. Scope: profile opt-in daily digest at workspace-local 6 AM, trailing 24h **event** timestamps, visibility-scoped groups, replay-safe window key. Live mailbox send is out of scope.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| A deal funded three days ago does not appear merely because it was edited today | Passed | `tests/milestone06-digest.test.ts` — `status_changed` to `funded` on Jan 12 is omitted from the Jan 14 11:00Z–Jan 15 11:00Z window even though `deals.updated_at` and `updated` activity fall inside the window |
| A replay does not send a second digest for the same recipient/window | Passed | Second `runDailyDigests` / `POST /api/mca/comms/jobs/run` with the same `nowIso` does not call transport again; unique `(workspace_id, membership_id, window_start)` keeps one row |
| Synthetic scenario: groups, visibility, timezone/DST, suspended | Passed | New / submitted / approved / funded groups with in-group dedup; a deal in new **and** submitted; admin sees unassigned-to-rep deals, rep does not; EST 6 AM vs EDT 6 AM; deactivated member `skipped` with `suspended`; invalid IANA timezone skipped |
| Loading / empty / validation / success / failure UI; retries preserve identity | Passed | `DigestSettings` copy for loading, off, timezone validation, enabled success, `role="alert"`; empty window `skipped`; failed transport `state = failed` and retry reuses `id` / `correlation_id` |
| Direct API permissions match UI; secrets excluded | Passed | Session GET/PATCH 200; `deals:read`, `deals:write`, and `intake:write` keys 403; other-workspace session cannot see this membership’s opt-in; SMTP password and webhook token omitted from JSON and webhook bodies |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-digest.test.ts
```

3/3 passed.

## Behavior

- Default send hour is **6** in the workspace IANA timezone; members may change timezone and hour `0–23`.
- Window end is today’s local send instant; window start is exactly 24 hours earlier. Runs before that instant are `not_due`.
- New = `deal_activity.action = created`. Submitted = `to_status` in `submitted` / `resubmitting`. Approved = `offer` / `contract`. Funded = `to_status = funded` or committed `mca_funding_events.funded_at`.
- Recipients are active members with `enabled = 1` and a usable email. Deal rows pass `canActorAccessDeal`.
- Accepted delivery is `sent` or non-production `preview`. Failed transport is not a successful digest.
- `runtime = "nodejs"`, `cache-control: no-store`, `assertTrustedMutation` on PATCH.

## UI

`DigestSettings` covers loading, empty (digest off), validation (timezone), success (enabled at hour/timezone), and failure (`role="alert"`). Preview lists current-window counts. Conductor mounts it on profile/settings.

## Local vs live gates

Local Postgres fixtures prove opt-in, event-time filtering, visibility, unique window replay, DST offsets, suspended skip, and injected transport. There is no live digest email. Fixture success is not production sending readiness.
