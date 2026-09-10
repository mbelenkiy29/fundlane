# MIC-110 report — Lead providers, purchase batches and cost attribution

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-110  
**Status:** implemented locally (conductor marks Done)

## What shipped

Workspace lead providers reuse MIC-155 `import_sources`. Purchase batches reuse `lead_batches` (`purchased_on`, `cost_cents`, `inactive`). Deal attribution is append-only in `mca_deal_acquisition_events` with a stable `(workspace_id, correlation_id)` identity.

- Admin/super_admin APIs for sources, batches, cost, unassigned reconciliation, and purchased-package import.
- Purchased-package commit wraps MIC-155 import and attaches every created deal to the chosen batch, snapshotting cost/date.
- Intake and manual assignment write the same event stream. Retries with the same correlation id return the same event.
- Inactive sources/batches cannot be selected for new deals; historical events and deal counts remain.
- Cross-workspace source IDs are rejected with `cross_workspace_source`.
- Cost is integer cents: `null` is missing, `0` is a real zero. Cost edits do not rewrite historical snapshots.
- `ProvidersPanel` covers loading, empty, validation, success, and failure. API roles match the admin UI.

## Files

- `src/lib/mca/leads/**`
- `src/app/api/mca/leads/**`
- `src/components/mca/leads/providers-panel.tsx`
- `tests/milestone06-leads.test.ts`
- `docs/milestone-06/MIC-110-report.md`
- `docs/milestone-06/MIC-110-acceptance.md`

Did not edit schema, migrations, `src/lib/mca/imports/**`, or `deals-workspace.tsx`.

## Checks

```bash
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-leads.test.ts
```

7 passed using `tests/helpers/postgres-test-db.mjs`. ESLint on exclusive files: clean after the test used the representative actor.

## Gates

None for this ticket. No live provider. Existing `/api/mca/imports/:id/commit` still does not write acquisition events; use `/api/mca/leads/packages/:runId/commit` or `POST .../attach`.

## Handoff

Mount `ProvidersPanel` on Settings → Connections or the import UI. Optionally rewire MIC-155 commit to `commitPurchasedPackage` / `attachImportRunAcquisitions` so the legacy import center also attributes cost. MIC-116 can read `listLatestAcquisitions` and `lead_batches.cost_cents`.
