# MIC-124 report — Adapter framework and credential environments

**Status:** DONE locally with synthetic fixtures. Live funder API credentials remain an external gate.

## Contract

`submitViaAdapter` loads workspace-scoped AES-GCM credentials for the requested environment, injects them through `adapterRuntime()`, and never falls back to another environment or tenant. Missing, inactive, mismatched, or undeclared credentials return `provider_unavailable` with a correlation id.

`FunderAdapter` is unchanged: `validate`, `submit`, optional `getStatus` / `parseWebhook`, and capability flags. Effective `statusPoll` is true only when the registered adapter both advertises it and implements `getStatus`. Submit-only adapters hide the status action and 409 `capability_unsupported` on the status API.

Development and production rows are unique on `(workspace_id, funder_id, environment)`. Ciphertext AAD is the workspace id and the payload embeds `workspaceId` + `environment`, so a development cipher copied into a production slot is rejected. Production `NODE_ENV` defaults to the production slot.

Rate-limited adapter errors surface `rate_limited` with `retryAt` / `externalRef`. HTTP retry reuses the same credential id, correlation id, and external reference. Logs and JSON omit secret values.

Writes are interactive `admin` / `super_admin` sessions (`assertTrustedMutation`). `deals:read` may list redacted slots. `intake:write` is 403.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/adapters-framework.test.ts
```

5/5 passed.

Covered: submit-only cannot status-check (HTTP 409 and `getStatusViaAdapter`); production does not read the development cipher (including a copied ciphertext and cross-tenant AAD); missing credential → `provider_unavailable`; admin-only writes (rep and intake 403, `deals:read` GET, identity-preserving PATCH); rate-limit retry keeps credential/correlation/external refs; responses and audit metadata omit secrets.

## Files

- `src/lib/mca/submissions/adapters/contracts.ts`
- `src/lib/mca/submissions/adapters/credentials.ts`
- `src/lib/mca/submissions/adapters/framework.ts`
- `src/app/api/mca/adapters/route.ts`
- `src/app/api/mca/adapters/[id]/route.ts`
- `src/app/api/mca/adapters/[id]/status/route.ts`
- `src/app/api/mca/adapters/[id]/retry/route.ts`
- `src/components/mca/submissions/adapter-credentials-panel.tsx`
- `tests/adapters-framework.test.ts`
- `docs/milestone-04/MIC-124-acceptance.md`
- `docs/milestone-04/MIC-124-report.md`

Did not edit `registry.ts`, `schema.ts`, drizzle, `deliver.ts`, or settings/connections.

## Remaining gates

Commercial funder sandbox credentials and live adapter HTTP. Fixture success is not production integration readiness. MIC-113 owns polling/webhooks against `getStatusViaAdapter` / `parseWebhookViaAdapter`.

## Handoff

Mount `AdapterCredentialsPanel` on settings/connections.
