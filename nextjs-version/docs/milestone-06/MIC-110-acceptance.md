# MIC-110 acceptance — Lead providers, purchase batches and cost attribution

Verified against Linear MIC-110 and `docs/milestone-06/MIC-110-brief.md`. Synthetic fixtures only. No production rows were changed.

## Linear boxes

| Criterion | Result |
| --- | --- |
| Importing a purchased package attaches every created deal to the chosen batch | Pass. Two-row CSV commit created both deals and wrote acquisition events for that `lead_batches` id with the batch cost/date snapshot. Retry kept the same event ids. |
| A source in another workspace cannot be selected | Pass. Foreign `import_sources` id is `cross_workspace_source` on batch create, deal assignment, and purchased-package preview. |
| Realistic synthetic scenario | Pass. Provider + paid batch + import/intake/manual assignment + cost correction + deactivate + unassigned reconciliation. |
| Loading / empty / validation / success / failure; retries preserve identity | Pass. `ProvidersPanel` states; assignment and import-run attach reuse `(workspace_id, correlation_id)`. |
| API permissions match UI; logs exclude secrets | Pass. Representative session is 403 on GET/PATCH/POST. Audit metadata stores source/batch/event ids, not merchant names or documents. |

## Frozen behavior

- Same `import_sources` / `lead_batches` identity as MIC-155. No second batch table.
- `cost_cents` null = missing; `0` = zero. UI copy: “Blank is missing cost. 0.00 is a real zero.”
- Inactive source/batch omitted from selectable lists. Historical `mca_deal_acquisition_events` rows remain after rename, cost correction, or deactivate.
- Cost PATCH is admin/super_admin. Unassigned deals are listed for admin reconciliation.

## Commands

```bash
cd nextjs-version && node --conditions=react-server --import tsx --test --test-concurrency=1 tests/milestone06-leads.test.ts
```

7 passed on a disposable Neon database from `tests/helpers/postgres-test-db.mjs`.

## Remaining gates

None. Conductor still needs to mount `ProvidersPanel` and, if desired, point the existing import commit button at the leads attach/commit routes.
