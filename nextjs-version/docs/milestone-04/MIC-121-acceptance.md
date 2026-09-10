# MIC-121 acceptance — Email sender connections

Executed September 8, 2026. Scope: Google/Microsoft OAuth plus encrypted SMTP/SendGrid sender connections, member ACL, default-per-purpose, test-send, and expired reconnect without deleting the row. Live OAuth remains an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Admin SMTP create, list, test-send preview | Passed | `tests/senders.test.ts` — HTTP 201, list contains id, `delivery: "preview"` then `verified` |
| Forged sender id is 403, not the foreign sender | Passed | Rep PATCH and test-send on an unshared id return `403 permission_denied`; `assertSenderUsable` same |
| Share with rep, then test-send | Passed | PATCH `memberIds`; rep list includes sender; test-send preview; `assertSenderUsable` succeeds |
| Expired reconnect keeps identity | Passed | `expireSender` returns `reconnect.available`; same id/members/credential cipher; test-send `409 sender_expired`; replacing password does not create a new row |
| `intake:write` POST 403 | Passed | Bearer intake key 403 on POST; `deals:read` GET lists `hasCredential` metadata |
| No secrets in JSON | Passed | Responses omit `credentialCipher` / password / API key / OAuth tokens; ciphertext decrypts only with workspace AAD |
| Default unique per purpose | Passed | Two `submission` defaults; second unsets first; `merchant` default is independent |
| OAuth start without env | Passed | Google sender stays `pending`; POST `/oauth` is `503 sender_oauth_not_configured` |
| OAuth start with env + fixture callback | Passed | Google authorize URL with `gmail.send` and `access_type=offline`; callback verifies same id/members |
| Webhook test-send redacted | Passed | POST body is `sender_test` without SMTP password |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/senders.test.ts
```

11/11 passed.

## Behavior

- Create/update/revoke/members/default/OAuth start: interactive `admin` / `super_admin` session, `assertTrustedMutation`, `cache-control: no-store`, `runtime = "nodejs"`.
- Reps see and use only senders they are members of. Forged ids are `403 permission_denied`.
- `deals:read` API keys may list workspace senders as metadata. Config writes require a session. `intake:write` is 403.
- SMTP stores host, port, username, password. SendGrid stores an API key. Google/Microsoft store OAuth tokens. All via `encryptSensitive(value, workspaceId)`.
- Test-send requires ACL. `MCA_EMAIL_WEBHOOK_URL` receives a redacted payload; otherwise non-production `delivery: "preview"`. Rate-limited per sender.
- Missing `MCA_*_SENDER_CLIENT_ID` / `SECRET` / `MCA_APP_ORIGIN` → `503 sender_oauth_not_configured` with the sender row left `pending` and reconnectable.
- Expired/revoked tokens set `state` accordingly, keep ciphertext and members, and expose `reconnect`. Reconnect does not delete the row.
- Default is unique per purpose in the workspace. Setting a new default unsets the previous default of that purpose.
- `assertSenderUsable(actor, senderId, purpose)` allows admin or members, requires matching purpose and `verified` state.

## UI

`SenderConnectionsPanel` covers loading, empty, validation, success, failure, expired reconnect, test-send, member ACL, and default-per-purpose. Conductor mounts it on settings/connections.

## Local vs live gates

Local Postgres fixtures prove ACL, encryption, preview test-send, default uniqueness, and OAuth start/callback wiring. Live Google/Microsoft authorization is not production-verified. Mock/fixture success is not production integration readiness.
