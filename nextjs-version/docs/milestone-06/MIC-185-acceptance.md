# MIC-185 acceptance — Entrance SMS adapter

Executed against public Entrance API v2 docs (https://docs.entrancegrp.com/, npm `entrancesms`). Scope: `SmsAdapter` for slug `entrance` with login email + API secret/password, synthetic fixtures, honest capability flags. Live Entrance send is out of scope. Conductor registers the adapter after review.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Required-field rejection | Pass | `validate({})` returns `loginEmail` and `apiSecret` errors; invalid email rejected; `email`/`password` aliases accepted |
| Accepted send | Pass | Login `POST https://apiv2.entrancegrp.com/authentication/login` then `POST /workspaces/3/messages` with Bearer token; body `{ channel_id: 1028, message: "Exact synthetic preview", number: "+12125550123" }`; one external id; replay of the same `correlationId` does not send again |
| Rejected-number | Pass | `+15550000999` → `failed` / `entrance_invalid_number`; error text omits recipient, body, and secret |
| Timeout / unconfigured credential | Pass | Missing creds → `entrance_unconfigured`; expired secret → `entrance_unauthorized`; timeout then recover mints one external id |
| Retried status callback without duplicate row | Skipped | `statusCallbacks: false`. Public docs name `messageStatus` and campaign `/message-status/campaign` only. No documented outbound DLR payload or signature. `parseStatus` is unimplemented |
| Capability flags match implementation | Pass | `{ send: true, statusCallbacks: false, inbound: true, optOut: true }`; `parseInbound` present; `parseStatus` absent |
| Inbound START/STOP | Pass | Public `receive-sms` envelope: `start` → `opt_in`, `STOP` → `opt_out`, `start2` → `message` |
| Secrets excluded | Pass | API secret never appears in send results or the messages request body |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/sms-adapters/entrance.test.ts
```

7/7 passed.

## Behavior

- Credentials: `loginEmail` + `apiSecret` (Linear: customer login email, API secret/password).
- `testConnection` is `ok` only when `account.providerConfigured`.
- Default send is fixture-backed (`entranceFixtureFetch`). No live `apiv2.entrancegrp.com` call from this ticket.
- Phone `senderIdentity` maps `message` + `number` and omits `channel_id`. Numeric `senderIdentity` maps documented `channel_id`.
- `statusCallbackUrl` is accepted on the port and unused: Entrance has no documented per-send callback URL field.

## Local vs live gates

Local fixtures prove mapping, idempotency, rejected-number, timeout identity, inbound keywords, and secret redaction. There is no Entrance sandbox session. Fixture success is not production sending readiness.
