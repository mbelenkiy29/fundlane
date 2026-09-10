# MIC-180 acceptance — Data Merch

Executed locally against workspace-bound SQLite, encrypted credentials, and fixture HTTP for `GET https://api.datamerch.com/v2/merchants`. Live Data Merch keys remain an external gate.

## Provider contract

- URL: `GET https://api.datamerch.com/v2/merchants`
- Auth: `Authorization: Bearer <workspace key>`
- Query: `q` = deal EIN from `getDealForDocument` (unmasked), else legal name. `getDeal` masks EIN and is not used for the lookup.
- Mapping: JSON `{ merchants: [{ id, name, ein, risk_level, records: [{ category, notes, funder, created_at }] }] }`. `recordCount` is the sum of `records` arrays (a merchant without `records` counts as one). Empty merchants → `no_result`. HTTP 401 → failed `credential_expired`. Network/non-OK → `failed`.

## Verification

| Check | Result | Evidence |
| --- | --- | --- |
| Workspace-bound encryption; GET never returns the key | Passed | `tests/datamerch.test.ts` |
| Disabled config hides run; API 409 `datamerch_disabled` | Passed | same |
| `q` is EIN when present, legal name otherwise | Passed | same; fixture captured URL + Bearer |
| `no_result` vs `failed` persist with deal version | Passed | same |
| Expired / 401 credential recoverable; no secret in body | Passed | same |
| Missing EIN and legal name | Passed | 422 `validation_failed` |
| Cross-workspace 404; retry keeps check id | Passed | same |
| Admin config, `deals:write` run, `deals:read` view, `intake:write` 403 | Passed | same |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/datamerch.test.ts
```

8/8 passed.

## Behavior

- Config: `admin` / `super_admin` session. Encrypted with `encryptSensitive(value, workspaceId)`. Enable requires a stored key.
- Run/View: deal access via `getDealForDocument`. Run needs `deals:write` (API keys) and enabled config. View needs `deals:read`.
- Disabled: `DataMerchPanel` hides Run; POST returns 409 `datamerch_disabled`.
- Expired stored `credentialExpiresAt` or provider 401 persists `failed`, keeps the encrypted key, and succeeds after a new key is saved.
- Correlation id retries return the same check and do not call Data Merch again.
- UI: loading, empty, validation, success, `no_result`, and failed/expired states. `DataMerchConfigPanel` is exported for the conductor to mount on settings.

## External gate

Live `api.datamerch.com` verification is pending a real workspace key. Fixture success is not production integration readiness.
