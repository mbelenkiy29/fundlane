# MIC-124 acceptance — Adapter framework and credential environments

Executed September 8, 2026. Scope: funder API adapter execution, isolated development/production credentials, capability-gated status checks, rate-limit retry with external references, and admin-only credential writes. Live funder APIs remain an external gate.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Submit-only adapter cannot advertise or execute status-check | Passed | `tests/adapters-framework.test.ts` — listed `capabilities.statusPoll === false`; POST `/status` and `getStatusViaAdapter` return `409 capability_unsupported`; submit still succeeds |
| Production cannot fall back to test endpoints or another tenant | Passed | Production resolve/submit with only a development row is `provider_unavailable`; copied development cipher in a production slot is rejected; other-workspace AAD decrypt fails; other-tenant credential id is 403 |
| Missing credential → `provider_unavailable` | Passed | Unconfigured production submit returns `provider_unavailable`; development secrets do not satisfy production; status poll without production secrets is `503 provider_unavailable` |
| Admin-only writes; reads match UI | Passed | Rep and `intake:write` POST 403; admin POST 201; PATCH keeps the same id; `deals:read` GET lists `hasCredential` without secrets |
| Rate-limit retry preserves identity | Passed | First submit `rate_limited` with `ext-attempt-retry` / `corr-retry-1`; retry HTTP 200 on the same credential id and external reference |
| Loading / empty / validation / success / failure UI | Passed | `AdapterCredentialsPanel` loading copy, empty adapters, field-error correction, success status, rate-limit retry with external reference; status button only when `statusPoll` |
| Logs and JSON omit secrets | Passed | HTTP bodies, audit `metadata`, and error payloads omit API keys / `credentialCipher` |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters-framework.test.ts
```

5/5 passed.

## Behavior

- Credentials persist on `mca_adapter_credentials` unique `(workspace_id, funder_id, environment)` via `encryptSensitive(value, workspaceId)`. Cipher payload includes workspace id and environment; mismatches fail closed.
- `submitViaAdapter(job, { environment })` uses that environment only. `NODE_ENV=production` defaults to production. No development fallback.
- Effective capabilities come from the registered adapter. `statusPoll` requires `getStatus`. Submit-only 409s status-check.
- Rate-limit errors include `retryAt` and `externalRef`. Retry reuses credential id, correlation id, and external reference.
- Credential writes: interactive `admin` / `super_admin`, `assertTrustedMutation`, `cache-control: no-store`, `runtime = "nodejs"`. `deals:read` may list redacted slots.

## UI

`AdapterCredentialsPanel` covers loading, empty, validation, success, failure, environment isolation copy, status-check hidden for submit-only, and retry with external references. Conductor mounts it on settings/connections.

## Local vs live gates

Local Postgres fixtures prove environment isolation, capability 409s, admin ACL, and redaction. Live funder API credentials are not production-verified. Mock/fixture success is not production integration readiness.
