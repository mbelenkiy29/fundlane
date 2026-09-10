# MIC-121 brief — Email sender connections

Read this first. It is the requirements, with exact values to use verbatim.

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-121/email-sender-connections-verification-and-reconnect-flow

**Wave:** 1. No M4 ticket may start after this until MIC-121 is review-clean.

## User story

As an authorized brokerage team member or administrator, I need email sender connections, verification and reconnect flow so I can complete this part of the MCA workflow with reliable data and clear next steps.

## Reference capability

Senders can be connected, verified, shared with selected users and made default.

[MCA Pilot source](https://docs.mcapilot.com/en/articles/9268937-connect-your-email-to-mca-pilot) — reviewed September 7, 2026.

## Proposed implementation (from Linear)

1. Build provider adapters for Google, Microsoft OAuth and encrypted custom SMTP including SendGrid.
2. Store credential references, permitted members, from-name, signature, verification time and connection state.
3. Distinguish merchant-facing, submission and fallback senders; validate allowed sender on every send.
4. Provide test-send, revoked-token recovery and throttling-aware queues; verify current provider authentication requirements before coding.

## Acceptance criteria

- An unauthorized rep cannot use another sender by forging its ID.
- An expired connection exposes a reconnect action and does not discard queued work.
- Each requirement above is demonstrated with a realistic synthetic scenario and documented expected output.
- Loading, empty, validation, success and failure states are usable; retries preserve record identity.
- Server-side permissions apply to direct requests as well as the UI, and no secrets or full sensitive document contents appear in logs.

## Exclusive files (you may only create/edit these)

- `src/lib/mca/senders/**` except `contracts.ts` (already frozen — import it, do not rewrite the exported types/unions)
- `src/app/api/mca/senders/**`
- `src/components/mca/senders/**`
- `tests/senders.test.ts`
- `docs/milestone-04/MIC-121-report.md`
- `docs/milestone-04/MIC-121-acceptance.md`

If you need a shared-file change (`schema.ts`, settings page, package.json), stop and report `NEEDS_CONTEXT`. Do not spawn subagents. Do not mark Linear Done. This repo has **no git** — do not try to commit.

## Frozen types

From `src/lib/mca/senders/contracts.ts`:

- providers: `google | microsoft | smtp | sendgrid`
- purposes: `merchant | submission | fallback`
- states: `pending | verified | expired | revoked`
- API never returns raw credentials. Use `hasCredential: boolean`.

Schema (already migrated in drizzle `0006_fancy_morph.sql`):

- `mca_email_senders`
- `mca_email_sender_members`
- `mca_email_oauth_states`

Encrypt secrets with existing `encryptSensitive` / `decryptSensitive` and workspace id as AAD. Follow Data Merch (`src/lib/mca/datamerch/`) and Drive OAuth (`src/lib/mca/imports/drive.ts`) patterns.

## Required behavior

1. **Admin / super_admin session** creates, updates, revokes, assigns members, sets default, starts OAuth. `sessionOnly: true`.
2. **Reps** cannot list or use senders they are not members of. Forging another sender id returns 403 `permission_denied`, not the foreign sender.
3. **API keys:** `deals:read` may list senders the key's workspace owns only as metadata if you choose to allow it; config writes require interactive admin session. `intake:write` is 403.
4. **SMTP / SendGrid:** store host, port, username, password (or API key), from address. Test-send uses nodemailer-less fixture: if `MCA_EMAIL_WEBHOOK_URL` is set, POST a redacted payload; otherwise `delivery: "preview"` in non-production. Never log passwords.
5. **Google / Microsoft OAuth:** if client id/secret/origin env vars are missing, start-OAuth returns 503 `sender_oauth_not_configured` with a reconnectable sender record that stays `pending`. Do not invent MCA Pilot endpoints. Env names:
   - `MCA_GOOGLE_SENDER_CLIENT_ID`, `MCA_GOOGLE_SENDER_CLIENT_SECRET`
   - `MCA_MICROSOFT_SENDER_CLIENT_ID`, `MCA_MICROSOFT_SENDER_CLIENT_SECRET`
   - `MCA_APP_ORIGIN`
6. **Expired / revoked tokens:** `state = expired`, UI shows Reconnect, credentials stay encrypted until replaced. Do not delete the sender row or member list.
7. **Default sender** is per purpose. Setting a new default unset the previous default of that purpose in the same workspace.
8. **Test-send** requires the actor to be allowed to use that sender. Unauthorized rep forging the id fails.
9. **assertSenderUsable(actor, senderId, purpose)** is the function later tickets (MIC-166/153) will import from `src/lib/mca/senders/service.ts`. Export it.
10. HTTP uses `assertTrustedMutation`, `requireWorkspaceAccess`, `apiError`, `runtime = "nodejs"`, `cache-control: no-store`.
11. UI: `SenderConnectionsPanel` matching existing settings cards (see `src/components/mca/datamerch/data-merch-panel.tsx` and `src/lib/mca/client.ts` `requestJson`). Loading, empty, validation, success, failure. Conductor will mount it on settings/connections after you land.

## Tests (`tests/senders.test.ts`)

Follow `tests/funders-directory.test.ts` / `tests/datamerch.test.ts`: `createPostgresTestDatabase`, seed workspace/users/sessions, cookie + bearer helpers.

Must cover:

- admin creates SMTP sender, lists it, test-send previews
- rep cannot PATCH another sender or test-send a sender they are not a member of (forge the id)
- admin shares sender with rep; rep can test-send
- expired sender returns reconnect payload and keeps id/members
- intake API key 403 on POST
- response JSON has `hasCredential` and never `credentialCipher` / password
- default sender uniqueness per purpose
- OAuth start without env → 503 `sender_oauth_not_configured` without crashing

Run:

```
cd nextjs-version
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/senders.test.ts
```

## Report

Write `docs/milestone-04/MIC-121-report.md` and `docs/milestone-04/MIC-121-acceptance.md`.

Return under 15 lines:

- Status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- Tests: command + pass/fail counts
- Files changed
- Gates remaining (live Google/Microsoft OAuth)
- Handoff for conductor (mount panel)
