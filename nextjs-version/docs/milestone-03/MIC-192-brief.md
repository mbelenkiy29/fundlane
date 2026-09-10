# MIC-192 brief — Funder directory

Ticket: https://linear.app/michael-belenkiy/issue/MIC-192/funder-directory-contacts-groups-and-routing-configuration

You implement **only** this ticket. Do not spawn subagents. There is **no git repository** — do not run git commit.

## Exclusive files (create/modify only these)

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

You may **import** (not edit): `src/lib/mca/funders/contracts.ts`, `deals/service.ts` (`actorForDeals`), `auth.ts`, `db.ts`, `errors.ts`, `http.ts`, `policy.ts` (`canManageWorkspace`), UI primitives.

Do not create `criteria` or `scan` API folders. Do not edit `deals-workspace.tsx`, `package.json`, or underwriting files.

## Types (already frozen)

Use `FunderRecord`, `FunderContact`, `FunderRoute`, `FunderGroup`, `FUNDER_ROUTE_KINDS` from `src/lib/mca/funders/contracts.ts`. Do not change that file.

## Required behavior

1. Workspace funder profiles: legal name (required), nickname, website, domains[], products[], active flag, contacts[], routes[].
2. Routes: kind `email | api | manual_portal | custom_webhook`, label, destination, documentExceptions[], active.
3. Named groups of funder IDs. `resolveGroup(actor, groupId)` returns unique **active** funder IDs only (dedupe, drop inactive).
4. Soft-archive: `active: false`. Never hard-delete. Inactive funders remain readable; `assertSelectableFunder` throws `422 inactive_funder` for new targeting.
5. Idempotent create via `idempotencyKey` unique per workspace.
6. profileVersion increments on profile/contact/route updates.
7. Writes: session `admin`/`super_admin` only (`requireWorkspaceAccess` with roles). Reads of active directory: `deals:read` or admin. Cross-workspace 404.
8. `intake:write` keys cannot list or mutate funders.
9. UI: `/funders` page with loading/empty/validation/success/failure, create/edit, groups, inactive toggle. Specific `funders/page.tsx` wins over `[section]/page.tsx`.

## Tests (TDD)

Write failing tests first in `tests/funders-directory.test.ts` using temp SQLite like `tests/documents-core.test.ts`.

Must include:

- Inactive funder cannot be selected (`assertSelectableFunder` / API 422) but GET by id still returns it for history.
- Group `[A, A, inactive B]` resolves to `[A]`.
- Cross-workspace create/list isolation.
- Idempotent create returns same id.
- API-key `intake:write` is 403.
- Rep session cannot POST.

Run:

```
cd nextjs-version
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/funders-directory.test.ts
```

Export functions other tickets will call:

- `listFunders(actor, { includeInactive?: boolean })`
- `getFunder(actor, id)`
- `createFunder(actor, input)`
- `updateFunder(actor, id, input)`
- `createGroup` / `updateGroup` / `resolveGroup(actor, groupId): string[]`
- `assertSelectableFunder(actor, funderId): FunderRecord`

Initialize SQLite in `directory-repository.ts` with `getDatabase().exec(schema)` like documents repository. Own tables: `mca_funders`, `mca_funder_groups`. JSON columns for contacts/routes/domains/products.

## Report

Write `docs/milestone-03/MIC-192-report.md` then return ONLY: Status, tests, files, concerns. Status DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT.
