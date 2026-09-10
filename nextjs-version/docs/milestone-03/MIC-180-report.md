# MIC-180 report — Data Merch

**Status:** DONE locally with fixture HTTP. Live Data Merch key is an external gate.

## Contract

`GET https://api.datamerch.com/v2/merchants` + `Authorization: Bearer <key>` + query `q` = EIN else legal name. Credentials encrypted with workspace-bound `encryptSensitive`. Disabled → UI hides Run, API `409 datamerch_disabled`. Expired credential recoverable; no secrets in logs or bodies.

## Tests

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/datamerch.test.ts
```

8/8 passed. TDD: tests failed `MODULE_NOT_FOUND` first, then implementation.

Covered: encryption + no secret leak; disabled 409; EIN vs legal name `q`; `no_result`/`records`/`failed` + deal version; expired then rotated key; missing identity 422; cross-workspace 404; retry identity; admin / `deals:write` / `deals:read` / `intake:write` 403.

## Files

- `src/lib/mca/datamerch/client.ts`
- `src/lib/mca/datamerch/repository.ts`
- `src/lib/mca/datamerch/service.ts`
- `src/app/api/mca/datamerch/route.ts`
- `src/app/api/mca/datamerch/[dealId]/route.ts`
- `src/components/mca/datamerch/data-merch-panel.tsx`
- `tests/datamerch.test.ts`
- `docs/milestone-03/MIC-180-acceptance.md`
- `docs/milestone-03/MIC-180-report.md`

Did not edit `contracts.ts`, `email.ts`, funders write APIs, `deals-workspace.tsx`, or `settings/connections/page.tsx`.

## Concerns

- `DataMerchPanel` / `DataMerchConfigPanel` are exported for the conductor to mount. This ticket did not edit shared settings or deal workspace.
- Project `tsc --noEmit` currently fails in unrelated MIC-170/MIC-172 files; no errors in datamerch paths.
- Live `api.datamerch.com` was not called.
