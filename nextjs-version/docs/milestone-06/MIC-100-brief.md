# MIC-100 brief — Role-scoped deal/offer CSV and admin workspace exports

**Linear:** https://linear.app/michael-belenkiy/issue/MIC-100
**UUID:** `339c77b9-7fbc-4b01-8d90-3b173415a1a9`
**Depends on:** MIC-91, MIC-109, MIC-94 (done)

## Exclusive files

- `src/lib/mca/exports/**`
- `src/app/api/mca/exports/**`
- `src/components/mca/exports/export-panel.tsx`
- `tests/milestone06-exports.test.ts`
- `docs/milestone-06/MIC-100-report.md`
- `docs/milestone-06/MIC-100-acceptance.md`

Do not edit `deals/service.ts` exportDeals unless `NEEDS_CONTEXT`. Prefer new export jobs using `mca_export_jobs` / `mca_export_download_tokens`. Do not edit `deals-workspace.tsx` (conductor mounts). No git. No subagents. Do not mark Linear Done.

## Frozen behavior

- Rep export uses the same authorized deal/offer query as the screen and omits payment fields.
- Admin exports: all-deals-and-owners and funded-deals with an explicit field manifest.
- Large exports are asynchronous with expiring authorized downloads and audit logs.
- Escape spreadsheet formulas (`=`, `+`, `-`, `@`, tab). Preserve identifier strings.
- This is not a payment export. Do not include ledger rows.

## Acceptance

- A rep export contains only visible records and allowed fields.
- Row count matches the query snapshot; embedded formula text is inert.
- Synthetic scenario, UI states, API permissions, no secrets in logs.
