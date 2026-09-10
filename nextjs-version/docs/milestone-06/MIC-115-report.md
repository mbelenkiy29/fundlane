# MIC-115 report — Scheduled merchant follow-ups by deal status

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-115/scheduled-merchant-follow-ups-by-deal-status
**Status:** implemented locally with synthetic fixtures. Conductor mounts the panel and jobs import; do not mark Linear Done from this agent.

## Contract

Workspace policies persist on existing `mca_followup_policies` / `mca_followup_occurrences` (migration `0012`; schema not edited). Unique occurrence key `(workspace_id, policy_id, deal_id, occurrence_key)`.

A policy is **status + channel + local schedule + published template + enabled + retry**. Local schedule is IANA timezone, `daily | weekly | monthly`, hour `0–23`, optional weekday (`0–6`, Sunday) or day of month. Retry defaults to **3** attempts / **15** minutes and is stored on the policy; failed rows keep `id` and `correlation_id`.

The scheduler handler registers with `registerCommsJob("followup", ...)` from `followups.ts`. `runFollowups` (and `POST /api/mca/comms/jobs/run` with `kinds: ["followup"]` plus injectable `nowIso`) sends the current local occurrence when `scheduled_for <= now`. Runs before that instant are `not_due`. Matching deals and existing `pending`/`failed` rows for that occurrence are processed. Status, SMS consent, and recipient are rechecked immediately before send. Leaving the target stage records `skipped` / `stage_changed` and does not deliver.

Replay of the same occurrence is a no-op (`already_sent`). Injected `setFollowupTransportForTests` / `setFollowupDeliveryFetchForTests` or non-production `preview` — no live email/SMS. Failed transport is not a successful follow-up.

Templates are rendered only through `getPublishedMessageTemplate` / `renderPublishedMessageTemplate` (MIC-147). Sender fallback / CC / BCC remain MIC-117.

## API

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/mca/comms/followups` | admin/super_admin session |
| POST | `/api/mca/comms/followups` | admin/super_admin session + trusted mutation |
| GET/PATCH | `/api/mca/comms/followups/:id` | admin session (PATCH is a mutation) |
| GET/POST | `/api/mca/comms/followups/preview` | admin session |
| POST | `/api/mca/comms/followups/:id/test` | admin/super_admin session + trusted mutation |

`runtime = "nodejs"`, `cache-control: no-store`. Preview does not write occurrences. Test mode delivers through the injected transport with `mode: "test"` and does not consume the live occurrence key. `deals:read` / `deals:write` / `intake:write` keys and reps are `403`. Cross-workspace policies are isolated.

## Tests

```
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-followups.test.ts
```

3/3 passed.

Covered: missing-documents email with template variables; moving out of the target stage skips with `stage_changed`; scheduler replay cannot send twice; unique occurrence row; approval SMS requires opt-in and skips opt-out / missing consent; renewal email; test/preview mode does not persist an occurrence; failed send stays `failed` and retry preserves identity; admin session vs API-key 403; UI loading/empty/validation/success/failure copy; webhook payload omits secrets.

## Files

- `src/lib/mca/comms/followups.ts`
- `src/app/api/mca/comms/followups/route.ts`
- `src/app/api/mca/comms/followups/preview/route.ts`
- `src/app/api/mca/comms/followups/[id]/route.ts`
- `src/app/api/mca/comms/followups/[id]/test/route.ts`
- `src/components/mca/comms/followup-panel.tsx`
- `tests/milestone06-followups.test.ts`
- `docs/milestone-06/MIC-115-report.md`
- `docs/milestone-06/MIC-115-acceptance.md`

Did not edit schema, `comms/contracts.ts`, `comms/jobs.ts`, `comms/templates.ts`, settings pages, or the jobs run route.

## Remaining gates

Live SMTP / Google / Microsoft / SMS provider sending. Injected transport and fixture `delivery: "preview"` are not production sending readiness. MIC-117 owns originator vs workspace sender fallback and CC/BCC.

## Handoff

Mount `FollowupPanel` from `src/components/mca/comms/followup-panel.tsx` on settings communications / follow-ups. Import `src/lib/mca/comms/followups.ts` from the conductor-owned comms jobs run route so `registerCommsJob("followup", ...)` is loaded in process.
