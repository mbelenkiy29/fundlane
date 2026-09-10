# MIC-192 report

Status: DONE

## Tests

`tests/funders-directory.test.ts` — 6/6 passed.

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/funders-directory.test.ts
```

Covered: inactive not selectable (422) but GET by id remains; group `[A, A, inactive B]` → `[A]`; cross-workspace isolation; idempotent create; `intake:write` 403; rep POST 403.

## Files changed

- `src/lib/mca/funders/directory.ts`
- `src/lib/mca/funders/directory-repository.ts`
- `src/app/api/mca/funders/route.ts`
- `src/app/api/mca/funders/[id]/route.ts`
- `src/app/api/mca/funders/groups/route.ts`
- `src/app/api/mca/funders/groups/[id]/route.ts`
- `src/components/mca/funders/funder-directory-panel.tsx`
- `src/app/(dashboard)/funders/page.tsx`
- `tests/funders-directory.test.ts`
- `docs/milestone-03/MIC-192-acceptance.md`
- `docs/milestone-03/MIC-192-report.md`

## Exports for later tickets

- `listFunders(actor, { includeInactive?: boolean })`
- `getFunder(actor, id)`
- `createFunder(actor, input)` → `{ funder, created }`
- `updateFunder(actor, id, input)`
- `createGroup` / `updateGroup` / `listGroups` / `getGroup` / `resolveGroup(actor, groupId): string[]`
- `assertSelectableFunder(actor, funderId): FunderRecord`

## Concerns

None. UI states are implemented in the panel; this ticket did not add a browser HTTP suite.
