# MIC-117 report — Follow-up sender fallback, CC and BCC settings

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-117/follow-up-sender-fallback-cc-and-bcc-settings
**Status:** implemented locally with synthetic fixtures. Conductor wires `resolveFollowupSender` into `followups.ts`; do not mark Linear Done from this agent.

## Contract

Workspace follow-up sending is **workspace-shared** or **originator**.

- `workspace_shared`: every message uses the verified **fallback** sender (`purpose = fallback`). Submission and merchant senders are not used.
- `originator`: send from the deal originator’s **merchant-facing** sender (`purpose = merchant` assigned to the originator membership) when it is connected and verified. If that sender is missing, expired, revoked, or unverified, the verified fallback is selected **exactly once** (`usedFallback: true`, `fallbackAttempts: 1`). A later resolve of the same deal returns the same fallback sender id. Submission senders are never a second fallback.

When neither the originator merchant sender nor the fallback sender is usable, resolution is `ok: false`, `success: false`, `wouldSend: false`, `reason: sender_unavailable`, with a visible `problem` string. That is not a successful send.

Template **CC** is stored per follow-up/merchant template on `mca_followup_template_copy`. Fallback **BCC** (BCC me on reminder emails) copies the fallback sender address when enabled. Both are independent from `mca_submission_templates.cc_originator` / `cc_closer`. Preview returns `ccSource: "template"` and `bccSource: "fallback" | "none"` and never includes originator/closer submission-copy addresses.

Settings persist on `mca_followup_sender_settings` (stable `id` per workspace). Exclusive files cannot edit Drizzle; the module creates these tables on first use. Conductor should add them to schema.

`resolveFollowupSender(actor, { dealId, templateId, originatorMembershipId })` is the integration point for MIC-115. Preview shows the chosen sender (`fromName` / `fromAddress` / `source`).

## API

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/api/mca/comms/sender-fallback` | admin/super_admin session |
| PATCH | `/api/mca/comms/sender-fallback` | admin/super_admin session + trusted mutation |
| GET/POST | `/api/mca/comms/sender-fallback/preview` | admin/super_admin session |

`runtime = "nodejs"`, `cache-control: no-store`. PATCH body: `{ senderMode?, bccFallback?, templates?: [{ templateId, ccEmails }] }`. Preview query/body: `{ dealId?, templateId?, originatorMembershipId? }`. `deals:read` / `deals:write` / `intake:write` keys and reps are `403`. Cross-workspace settings and senders are isolated. SMTP passwords and `credentialCipher` are omitted from JSON.

## Tests

```
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-sender-fallback.test.ts
```

3/3 passed.

Covered: originator connected uses merchant sender; disconnecting originator selects the configured fallback once (same id on replay, never submission); neither sender → visible failure not success; workspace-shared ignores a connected originator; template CC and fallback BCC ignore submission `cc_originator` / `cc_closer`; PATCH retries keep settings `id`; admin session vs API-key/rep 403; gate loading/empty/validation/success/failure copy; secrets omitted.

## Files

- `src/lib/mca/comms/sender-fallback.ts`
- `src/app/api/mca/comms/sender-fallback/route.ts`
- `src/app/api/mca/comms/sender-fallback/preview/route.ts`
- `tests/milestone06-sender-fallback.test.ts`
- `docs/milestone-06/MIC-117-report.md`
- `docs/milestone-06/MIC-117-acceptance.md`

Did not edit `followups.ts`, schema, jobs, templates, or settings mounts.

## Remaining gates

Live SMTP / Google / Microsoft sending. Fixture sender verification (`delivery: "preview"`) is not production sending readiness. Runtime `CREATE TABLE IF NOT EXISTS` for settings/copy should be promoted into a conductor migration.

## Handoff

Import `resolveFollowupSender` from `src/lib/mca/comms/sender-fallback.ts` into `followups.ts` (replace `pickFollowupSender`) so live/preview/test follow-ups use originator vs workspace-shared selection, template CC, fallback BCC, and fail with `sender_unavailable` when neither sender works. Optionally add `mca_followup_sender_settings` and `mca_followup_template_copy` to schema. Mount catalog/preview on Settings → Follow Ups if a panel is desired; copy/gate live in `SENDER_FALLBACK_COPY` / `senderFallbackGate`.
