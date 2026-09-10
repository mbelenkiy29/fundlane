# MIC-121 report — Email sender connections

**Status:** DONE locally with synthetic fixtures. Live Google/Microsoft OAuth is an external gate.

## Contract

Providers `google | microsoft | smtp | sendgrid`. Purposes `merchant | submission | fallback`. States `pending | verified | expired | revoked`. API never returns raw credentials; public JSON uses `hasCredential`. Secrets use `encryptSensitive` / `decryptSensitive` with workspace id as AAD.

Admin / `super_admin` sessions create, update, revoke, assign members, set default, and start OAuth (`sessionOnly: true`). Reps cannot list or use senders they are not members of; forging a sender id returns `403 permission_denied`. `deals:read` API keys may list workspace metadata. Config writes need an interactive admin session. `intake:write` is 403.

Missing OAuth env vars return `503 sender_oauth_not_configured` and leave a reconnectable `pending` sender. SMTP/SendGrid test-send POSTs a redacted payload to `MCA_EMAIL_WEBHOOK_URL` when set; otherwise `delivery: "preview"` outside production. Expired connections expose reconnect and keep id, members, and encrypted credentials.

`assertSenderUsable(actor, senderId, purpose)` is exported from `src/lib/mca/senders/service.ts` for MIC-166/153.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/senders.test.ts
```

11/11 passed.

Covered: admin SMTP create/list/test-send preview; forged sender id 403 on PATCH and test-send; share then rep test-send; expired reconnect keeps identity/members; intake POST 403; `hasCredential` and no `credentialCipher`/password; default uniqueness per purpose; OAuth start without env 503; OAuth start with env + fixture callback; webhook redaction; cross-workspace 403 and purpose mismatch.

## Files

- `src/lib/mca/senders/repository.ts`
- `src/lib/mca/senders/oauth.ts`
- `src/lib/mca/senders/delivery.ts`
- `src/lib/mca/senders/service.ts`
- `src/app/api/mca/senders/route.ts`
- `src/app/api/mca/senders/[id]/route.ts`
- `src/app/api/mca/senders/[id]/test/route.ts`
- `src/app/api/mca/senders/[id]/oauth/route.ts`
- `src/app/api/mca/senders/[id]/revoke/route.ts`
- `src/app/api/mca/senders/oauth/callback/route.ts`
- `src/components/mca/senders/sender-connections-panel.tsx`
- `tests/senders.test.ts`
- `docs/milestone-04/MIC-121-acceptance.md`
- `docs/milestone-04/MIC-121-report.md`

Did not edit `contracts.ts` exported unions/types, `schema.ts`, drizzle, `package.json`, or `settings/connections/page.tsx`.

## Remaining gates

Live Google OAuth (`MCA_GOOGLE_SENDER_CLIENT_ID` / `MCA_GOOGLE_SENDER_CLIENT_SECRET` / `MCA_APP_ORIGIN`) and live Microsoft OAuth (`MCA_MICROSOFT_SENDER_CLIENT_ID` / `MCA_MICROSOFT_SENDER_CLIENT_SECRET` / `MCA_APP_ORIGIN`). Fixture success is not production integration readiness.

## Handoff

Mount `SenderConnectionsPanel` on settings/connections.
