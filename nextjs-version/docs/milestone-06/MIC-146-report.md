# MIC-146 report — Opt-in daily deal activity email digest

**Status:** DONE locally with synthetic fixtures. Live mailbox send remains an external gate.

## Contract

Profile opt-in is per membership on `mca_digest_subscriptions` (`enabled`, IANA `timezone`, `local_send_hour`, default **6** in the workspace timezone). `GET`/`PATCH /api/mca/comms/digest` and `GET /api/mca/comms/digest/preview` are **session-only**. API keys, including `deals:read` / `deals:write` / `intake:write`, are `403 session_required`.

The scheduler handler registers with `registerCommsJob("digest", ...)` from `digest.ts`. `runDailyDigests` (and `POST /api/mca/comms/jobs/run` with `kinds: ["digest"]` plus injectable `nowIso`) sends the trailing **24 hours** ending at that local send instant. Events before local send hour are `not_due`.

Activity is **event timestamps only**: `deal_activity.created_at` for `created` and `status_changed`, plus committed `mca_funding_events.funded_at`. `deals.updated_at` and `updated` activity are ignored. Groups: new / submitted / approved / funded. Dedup is by `dealId` within each group. Each recipient is scoped with `canActorAccessDeal`.

`mca_digest_deliveries` unique `(workspace_id, membership_id, window_start)` makes replay a no-op. Failed transport stores `state = failed` (not sent); retry keeps `id` and `correlation_id`. Suspended (`memberships.status !== active`) and empty windows are `skipped` with reasons. Invalid timezones are skipped and not recorded. Injected `setDigestTransportForTests` / `setDigestDeliveryFetchForTests` or non-production `preview` — no live email. Failed send is not a successful digest.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-digest.test.ts
```

3/3 passed.

Covered: funded three days ago + edited inside the window is omitted; grouping and in-group dedup; rep vs admin visibility; replay of the same window does not send twice; EST vs EDT 6 AM windows; suspended member skipped; invalid timezone skipped; failed send stays `failed` and retry preserves identity; session opt-in vs API-key 403; UI loading/empty/validation/success/failure copy; webhook payload omits secrets.

## Files

- `src/lib/mca/comms/digest.ts`
- `src/app/api/mca/comms/digest/route.ts`
- `src/app/api/mca/comms/digest/preview/route.ts`
- `src/components/mca/comms/digest-settings.tsx`
- `tests/milestone06-digest.test.ts`
- `docs/milestone-06/MIC-146-report.md`
- `docs/milestone-06/MIC-146-acceptance.md`

Did not edit `comms/jobs.ts` except calling `registerCommsJob` from `digest.ts`. Did not mount the settings panel or import `digest.ts` from the jobs run route.

## Remaining gates

Live SMTP / Google / Microsoft sending (`MCA_EMAIL_WEBHOOK_URL` or a real mailbox). Injected transport and fixture `delivery: "preview"` are not production sending readiness.

## Handoff

Mount `DigestSettings` on profile/settings. Import `src/lib/mca/comms/digest.ts` from the conductor-owned comms jobs run route so `registerCommsJob("digest", ...)` is loaded in process.
