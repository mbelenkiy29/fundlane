# MIC-192 acceptance — Funder directory

Executed September 8, 2026. Scope: workspace funder profiles, contacts, routes, named groups, soft-archive, and `/funders` UI.

## Verification summary

| Check | Result | Evidence |
| --- | --- | --- |
| Directory core + HTTP acceptance | 6/6 passed | `tests/funders-directory.test.ts` |
| Inactive targeting rejected, history readable | Passed | `assertSelectableFunder` 422 `inactive_funder`; GET by id still returns the archived row |
| Group resolution | Passed | `[A, A, inactive B]` resolves to `[A]` |
| Workspace isolation | Passed | Cross-workspace get/list/group membership 404 |
| Idempotent create | Passed | Same workspace key returns the same id; HTTP replay is 200 |
| Permissions | Passed | `intake:write` list/mutate 403; rep POST 403; `deals:read` GET 200 |

Command:

```
node --conditions=react-server --import tsx --test --test-concurrency=1 tests/funders-directory.test.ts
```

## Behavior

- Workspace funder profiles persist legal name, nickname, website, domains, products, contacts, routes, and an active flag. Routes support `email | api | manual_portal | custom_webhook` with label, destination, document exceptions, and an active flag.
- Named groups store funder IDs as authored. `resolveGroup` returns unique **active** funder IDs only.
- Soft-archive sets `active: false`. Rows are never hard-deleted. GET by id remains available for history. `assertSelectableFunder` and `POST /api/mca/funders/[id]` return 422 `inactive_funder`.
- Create is idempotent per workspace `idempotencyKey`. Profile/contact/route updates increment `profileVersion`. `criteriaVersion` stays at 1 for MIC-170.
- Writes require an interactive `admin` / `super_admin` session. Reads of the directory accept session users or API keys with `deals:read`. `intake:write` cannot list or mutate funders. Cross-workspace access is 404.
- `/funders` replaces the placeholder section page (specific route wins over `[section]`). The panel covers loading, empty, validation, success, and failure, plus create/edit, groups, and an inactive toggle.

## Local vs live gates

Local SQLite fixtures prove isolation, archive, group resolution, idempotency, and permission envelopes. No external provider is involved. Production verification is the same brokerage permission model already used for deals; there is no live-integration gate for this ticket.
