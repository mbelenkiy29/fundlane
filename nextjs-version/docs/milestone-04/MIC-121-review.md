# MIC-121 review — Email sender connections

**Spec:** PASS
**Quality:** Approved (Minor)

Live Google/Microsoft OAuth remains an allowed remaining gate. Fixture success is not production-verified. No live merchant submissions in this surface.

## Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| Frozen unions unchanged (`google\|microsoft\|smtp\|sendgrid`, `merchant\|submission\|fallback`, `pending\|verified\|expired\|revoked`, `hasCredential`) | Pass | `src/lib/mca/senders/contracts.ts:3-24`. Reconnect extras live on `SenderConnection` in `service.ts:52-59`, not on frozen `EmailSender`. |
| Unauthorized rep forging a sender id → 403, not the foreign sender | Pass | HTTP PATCH/test-send `403 permission_denied` (`tests/senders.test.ts:226-254`). Missing id also 403, not 404 (`244-249`). `assertCanView`/`assertCanUse` deny without returning the row (`service.ts:133-143`, `318-320`, `420-421`). Workspace-scoped `findSenderById` (`repository.ts:145-146`). |
| Expired reconnect keeps row/members/cipher | Pass | `expireSender` only updates state/error (`service.ts:505-516`). Test keeps id/members/cipher and `reconnect.available` (`tests/senders.test.ts:284-328`). Password replace stays same id (`324-327`). OAuth restart same id/members (`470-475`). UI Reconnect (`sender-connections-panel.tsx:273-306`). |
| Secrets never in API JSON | Pass | `toPublicSender` emits `hasCredential` only (`repository.ts:125-142`). `assertNoSecret` on create/list/test/oauth/errors (`tests/senders.test.ts:128-136`, `204`, `210`, `220`, `242`, `266`, `293`, `303`, `337`, `352`, `369`, `410`, `419`, `468`). Cipher decrypts with workspace AAD and fails other workspace (`371-374`). Webhook body has `sender_test` without SMTP password (`delivery.ts:27-37`, `tests/senders.test.ts:478-498`). |
| Admin session for config writes; `intake:write` 403 | Pass | `requireSenderAdmin`: `write`, `sessionOnly: true`, roles `admin`/`super_admin` (`service.ts:159-161`). Intake and `deals:read` POST 403 (`tests/senders.test.ts:330-343`). `deals:read` GET lists metadata (`345-352`). |
| Test-send ACL + preview/webhook | Pass | `requireSenderUse` session + `assertCanUse` (`service.ts:163-165`, `420-422`). Rate limit (`[id]/test/route.ts:15`). Preview when no webhook (`delivery.ts:43-51`). Production unconfigured 503 (`44-46`). |
| Default unique per purpose | Pass | `clearDefaultSenders` (`repository.ts:248-255`, `service.ts:334`, `367`). Two submission defaults unset the first; merchant independent (`tests/senders.test.ts:377-391`). |
| OAuth missing env → 503, pending reconnectable | Pass | Env names (`oauth.ts:61-71`). HTTP 503 `sender_oauth_not_configured`, row stays pending with members (`tests/senders.test.ts:394-425`). |
| `assertSenderUsable` exported | Pass | `service.ts:519-534`. Purpose mismatch 422 (`tests/senders.test.ts:511-513`). |
| HTTP: `assertTrustedMutation`, `requireWorkspaceAccess`, `apiError`, `runtime = "nodejs"`, `no-store` | Pass on mutation/list/get/test/oauth-start/revoke | All `src/app/api/mca/senders/**` except callback set `runtime = "nodejs"` and `cache-control: no-store`. Callback is GET + `requireWorkspaceAccess` session admin (`oauth/callback/route.ts:15-24`) — CSRF via hashed state, not `assertTrustedMutation`. |
| UI states + conductor mount | Pass | Loading/empty/validation/success/failure (`sender-connections-panel.tsx:250-258`, `74-80`, `167`, `226-227`). Panel mounted (`settings/connections/page.tsx:4`, `13`). |

## Quality

Approved. Minor only:

1. Microsoft authorize/callback is implemented (`oauth.ts:19-23`, `97-107`) but tests drive Google only (`tests/senders.test.ts:427-476`). Callback GET route itself is not HTTP-tested (service `completeSenderOAuth` is).
2. OAuth callback omits `cache-control: no-store` (`oauth/callback/route.ts:15-32`).
3. Expired/revoked cards still expose Send test; server correctly returns 409 (`sender-connections-panel.tsx:308-323`, `service.ts:409-411`).
4. `consumeOauthState` deletes the state before token exchange (`repository.ts:309-310`, `service.ts:481-489`); a failed exchange requires a new start. Identity is preserved.
5. `refreshSenderCredential` is unused on test-send; OAuth test-send never talks to Gmail/Graph. Allowed by the nodemailer-less fixture / live-OAuth gate.

No Critical or Important defects on the exclusive surface.

## Unverified claims

- **11/11 passed:** test file defines 11 `test("MIC-121:…")` cases matching the report; this review did not re-execute Postgres.
- **Did not edit `contracts.ts` unions / `schema.ts` / drizzle / `package.json`:** current unions and schema checks match the frozen set; repo has no git, so in-place rewrites cannot be proven.
- **Did not edit `settings/connections/page.tsx`:** mount is present; authorship vs conductor cannot be proven without git.
- **Live Google/Microsoft OAuth:** not production-verified (documented remaining gate).
