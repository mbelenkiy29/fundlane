# MIC-124 review — Adapter framework and credential environments

**Spec:** PASS
**Quality:** Approved (Minor)

Live funder APIs remain an external gate. Fixture success is not production integration readiness. MIC-113 owns polling/webhooks. Do not mark Linear Done from this review.

## Spec

| Requirement | Result | Evidence |
| --- | --- | --- |
| Submit-only cannot advertise or execute status-check | Pass | `effectiveAdapterCapabilities` requires `capabilities.statusPoll` **and** `getStatus` (`credentials.ts:251-266`). `assertStatusPollAllowed` 409 `capability_unsupported` (`framework.ts:135-138`). List/POST expose `statusPoll === false`; POST `/status` and `getStatusViaAdapter` 409; submit still succeeds (`tests/adapters-framework.test.ts:269-308`). Panel hides Check status unless `statusPoll` (`adapter-credentials-panel.tsx:251,279-284`). |
| Production cannot fall back to development or another tenant | Pass | Resolve SQL is exact `(workspace_id, funder_id, environment)` (`credentials.ts:347-355,385-410`). Cipher AAD is workspace id (`crypto.ts:42-56`); payload embeds `workspaceId` + `environment` and mismatches return undefined (`credentials.ts:220-234,396-399`). `NODE_ENV=production` defaults production (`credentials.ts:112-118`). Test: production with only a development row is `provider_unavailable`; copied development cipher in a production slot is rejected; other-workspace AAD decrypt fails; other-tenant GET 403 (`test:311-406`). |
| Missing credential → `provider_unavailable` | Pass | `loadRuntime` returns `provider_unavailable` with a correlation id (`framework.ts:157-167,228-230`). Submit result `ok: false`; `getStatusViaAdapter` throws 503 (`244-248`). Unconfigured production and development-only secrets fail closed (`test:408-431`). |
| Admin-only writes; reads match UI | Pass | Writes: interactive `admin` / `super_admin`, `sessionOnly`, `assertTrustedMutation`, plus `assertAdmin` (`credentials.ts:86-106,472-473`; routes `runtime = "nodejs"`, `cache-control: no-store`). GET: `deals:read`. Rep POST/PATCH 403; `intake:write` POST 403; admin POST 201; PATCH keeps the same id; `deals:read` lists `hasCredential` / `canManage: false` without secrets (`test:434-509`). |
| Rate-limit retry preserves identity; logs/JSON omit secrets | Pass | 429 maps `rate_limited` with `retryAt` / `externalRef` (`framework.ts:46-61,205-217`). Retry HTTP reuses credential id, correlation id, and external reference (`440-460`, `test:512-560`). `redactAdapterSecrets` on results, last-action JSON, and audit metadata (`credentials.ts:192-218,454-469`). `assertNoSecret` on HTTP, submit results, and `audit_events`. |
| `FunderAdapter` unchanged; exclusive files; `registry.ts` not required | Pass | `adapters/contracts.ts` re-exports `FunderAdapter` from `submissions/contracts.ts:151-158` (`validate`, `submit`, optional `getStatus` / `parseWebhook`, capability flags). Unique `(workspace_id, funder_id, environment)` already on `mca_adapter_credentials` (`db/schema.ts:1427-1450`). Current `registry.ts` is still the in-memory map (`registerAdapter` / `getAdapter` / `listAdapters`). Panel is mounted on settings/connections (`connections/page.tsx:5,15`). |

## Quality

Approved. Minor only:

1. UI Retry chooses `action: status` whenever `statusPoll` is true, not `lastAction.action` (`adapter-credentials-panel.tsx:198-201`). A submit-side rate limit on a status-capable adapter would retry status. HTTP retry in the test explicitly sends `action: "submit"` and `job.attemptKey`.
2. UI retry does not send `job.attemptKey`. `retryAdapterAction` then uses `lastAction.externalRef` as `attemptKey` (`framework.ts:449-451`), which is the external ref (`ext-…`), not the original attempt key. Identity is preserved on the HTTP contract the test covers, not on the panel’s default body.
3. `hasCredential` is `Boolean(credentialCipher)` (`credentials.ts:332`). A production row with a copied development cipher still lists as saved until resolve fail-closes.
4. `loadRuntime` only filters `adapterSlug` when `job.route.destination` is a registered adapter (`framework.ts:147-154`). An unregistered destination can bind any credential for that funder + environment.
5. Implementer handoff is stale: `AdapterCredentialsPanel` is already mounted. Report correctly says it did not edit `registry.ts` / schema / `deliver.ts`. `deliver.ts` already calls `submitViaAdapter(job)` with the resolved default environment.

No Critical or Important defects on the exclusive surface.

## Unverified claims

- **5/5 passed:** the test file defines five `test("MIC-124: …")` cases matching the report/acceptance; this review did not re-execute Postgres.
- **Did not edit `registry.ts` / `schema.ts` / drizzle / `deliver.ts`:** current stub registry, unique constraint, and API deliver path match the brief; the repo has no git, so in-place rewrites cannot be proven.
- **Logs redacted:** no `console.*` in the adapter modules; redaction is proven on HTTP/JSON/audit, not process logs.
- **Live funder sandbox HTTP:** not production-verified (documented remaining gate).
